// Builder payouts from the capped payout wallet (owner rules, 2026-10-26). Fees accrue per repository and wait; a claim
// pays what the ledger still owes the repository, in SOL, to its active payout wallet, and only when:
//   - the builder_payouts switch is on (claim_controls), checked again just before broadcast;
//   - claims are open for the repository (repo_claim_windows, which the paused repositories can never join);
//   - GitHub confirms, at most 60 seconds earlier, that the claimer is an admin of that exact repository ID;
//   - the payout wallet signed a one-use challenge bound to the repository ID, the wallet and a nonce;
//   - the amount fits the per-claim cap and the rolling 24-hour cap across every repository.
// The pending row (with the signed transfer) is durable before broadcast and blocks another claim for the repository. It
// settles only when both RPC providers show the finalized transfer moving exactly the amount and nothing else.
import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { resolvePayoutRecipient } from './payout-address.mjs'
import { builderCollectionState } from './builder-collection-state.mjs'
import { broadcastUntilSettled } from './trade-landing.mjs'
import { agreedFinalizedTransaction } from './graduation-state.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'

export const CLAIM_CHALLENGE_LIFETIME_MS = 5 * 60_000
export const GITHUB_PROOF_MAX_AGE_MS = 60_000
// The payout wallet never holds more than this; it is refilled from the vault through the multisig.
export const PAYOUT_WALLET_CAP_LAMPORTS = 2_000_000_000n
// Unclaimed balances go to the multisig vault this long after claims open for a repository.
export const UNCLAIMED_AFTER_MONTHS = 12
// Never opened and never swept (owner, 2026-10-25). repo_claim_windows refuses them too.
export const NEVER_SWEPT_REPOS = Object.freeze(['1250276806', '1332056763'])
// Closed even when claims are open for all (owner, 2026-10-26): the never-swept repositories and those whose owed fees the
// vault does not cover yet. claim_closed_repos holds the same list; either one keeps a repository closed.
export const CLOSED_CLAIM_REPOS = Object.freeze([...NEVER_SWEPT_REPOS, '1388219884', '1391948723'])
// Below this a claim waits for more fees: the payout wallet pays the network fee, so dust payouts only drain it.
export const MIN_PAYOUT_LAMPORTS = 1_000_000n
// At most this many unused, unexpired challenges per repository.
const MAX_LIVE_CHALLENGES = 5
const NETWORK_FEE_RESERVE_LAMPORTS = 10_000n
// Advisory locks wait at most this long; a busy claim is refused instead of holding a pool connection.
const LOCK_TIMEOUT = '20s'
const CHAIN_TIMEOUT_MS = 120_000
const SOL = 'So11111111111111111111111111111111111111112'
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
// One lock across repositories, so two claims cannot both fit the remaining daily cap. Its own two-int namespace, apart from
// the repo-ID locks (one bigint key) and the custody signature locks (188212).
const DAILY_CAP_LOCK = [188213, 0]

export class PayoutRefused extends Error {
  constructor(code, message) { super(message); this.name = 'PayoutRefused'; this.code = code }
}
const refuse = (code, message) => { throw new PayoutRefused(code, message) }

export const claimMessage = ({ githubRepoId, wallet, nonce, expiresAt }) => [
  'repo.ing builder payout claim v1',
  'I claim this repository\'s builder fees to this Solana wallet.',
  'Chain: Solana',
  `Repository ID: ${githubRepoId}`,
  `Wallet: ${wallet}`,
  `Nonce: ${nonce}`,
  `Expires: ${new Date(expiresAt).toISOString()}`,
  'This signature authorizes one payout. It does not send a transaction from your wallet.',
].join('\n')

export function unclaimedSweepDate(openedAt) {
  const date = new Date(openedAt)
  date.setUTCMonth(date.getUTCMonth() + UNCLAIMED_AFTER_MONTHS)
  return date
}

const repoIdOf = value => {
  const id = BigInt(value)
  if (id <= 0n) refuse('invalid-repository', 'GitHub repository ID must be positive')
  return id.toString()
}

// Off when the row is missing, disabled or unreadable.
export async function payoutControls(db) {
  try {
    const { rows: [row] } = await db.query(`select enabled, max_claim_lamports::text as "maxClaim", daily_lamports::text as daily
      from claim_controls where key = 'builder_payouts'`)
    return row?.enabled ? { enabled: true, maxClaim: BigInt(row.maxClaim), daily: BigInt(row.daily) } : { enabled: false }
  } catch { return { enabled: false } }
}

// Open when the repository has its own window, or when claims are open for all (claim_controls.opened_for_all_at); never for a
// closed repository. The opening date starts the 12-month unclaimed window.
export async function claimWindow(db, repoId) {
  const id = repoIdOf(repoId)
  if (CLOSED_CLAIM_REPOS.includes(id)) return null
  const { rows: [row] } = await db.query(`select coalesce(w.opened_at, c.opened_for_all_at) as "openedAt"
      from claim_controls c left join repo_claim_windows w on w.github_repo_id = $1
      where c.key = 'builder_payouts' and not exists (select 1 from claim_closed_repos x where x.github_repo_id = $1)`, [id])
  return row?.openedAt ? { openedAt: row.openedAt, unclaimedAfter: unclaimedSweepDate(row.openedAt) } : null
}

// What the ledger still owes: SOL credits minus every settled payout (pool, payout wallet and vault payouts all settle a
// repo_claims row) and settled platform collections.
export async function owedLamports(db, repoId) {
  const { rows: [row] } = await db.query(`select
      (select coalesce(sum(amount_base_units), 0) from builder_fee_credits where github_repo_id = $1 and asset = $2)
    - (select coalesce(sum(amount_base_units), 0) from repo_claims where github_repo_id = $1 and status = 'settled')
    - (select coalesce(sum(amount), 0) from builder_fee_collections where github_repo_id = $1 and status = 'settled')
    - (select coalesce(sum(amount), 0) from custody_owner_transfers where github_repo_id = $1 and role = 'creator') as owed`,
  [repoIdOf(repoId), SOL])
  return BigInt(row.owed)
}

// Every pending payout counts, however old: its SOL may already have moved.
async function dailyUsed(db) {
  const { rows: [row] } = await db.query(`select coalesce(sum(amount_base_units), 0)::text as used from repo_claims
    where payout_source = 'payout-wallet' and (status = 'pending' or (status = 'settled' and created_at > now() - interval '24 hours'))`)
  return BigInt(row.used)
}

const withTimeout = (promise, what) => Promise.race([promise, new Promise((_, reject) =>
  setTimeout(() => reject(Error(`${what} timed out`)), CHAIN_TIMEOUT_MS).unref?.())])

// The Solana side: reads and the finalized receipt from two providers. Tests replace it with a scripted chain.
export function solanaPayoutChain({ connection, verification }) {
  return {
    status: async signature => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] ?? null,
    expiredUnlanded: async (signature, lastValidBlockHeight) => BigInt(await connection.getBlockHeight('finalized')) > BigInt(lastValidBlockHeight) &&
      provablyExpiredUnlanded(connection, signature, lastValidBlockHeight),
    rebroadcast: bytes => connection.sendRawTransaction(bytes, { skipPreflight: false }),
    balance: async address => BigInt(await connection.getBalance(new PublicKey(address), 'confirmed')),
    rentMinimum: async () => BigInt(await connection.getMinimumBalanceForRentExemption(0, 'confirmed')),
    latestBlockhash: () => connection.getLatestBlockhash('confirmed'),
    simulate: async transaction => (await connection.simulateTransaction(transaction)).value.err,
    broadcast: (bytes, landing) => broadcastUntilSettled(connection, bytes, landing),
    finalize: async (signature, latest) => (await withTimeout(connection.confirmTransaction({ signature, ...latest }, 'finalized'), 'Finality')).value.err,
    receipt: signature => withTimeout(agreedFinalizedTransaction(connection, verification, signature), 'Receipt read'),
  }
}

// Exactly one transfer of `amount` from payer to recipient, and nothing else moved.
export function checkPayoutReceipt(tx, { payer, recipient, amount }) {
  const keys = (tx?.transaction?.message?.staticAccountKeys ?? tx?.transaction?.message?.accountKeys ?? []).map(k => k.toString())
  const meta = tx?.meta
  if (!meta || meta.err !== null || keys.length !== meta.preBalances?.length || keys.length !== meta.postBalances?.length) return false
  return keys.every((key, i) => {
    const delta = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i])
    if (key === recipient) return delta === amount
    if (key === payer) return delta === -(amount + BigInt(meta.fee))
    return delta === 0n
  })
}

export function createBuilderPayouts({ pool, payoutSigner, githubVerifier, chain, now = () => new Date() }) {
  const payer = payoutSigner.publicKey.toBase58()

  async function currentAdmin(repoId) {
    const github = await githubVerifier.verifyCurrentAuthority({ githubRepoId: BigInt(repoId) })
    const checkedAt = new Date(github?.verifiedAt)
    if (github?.verified !== true || github.permission !== 'admin' || String(github.githubRepoId) !== repoId ||
        !Number.isFinite(checkedAt.getTime()) || now().getTime() - checkedAt.getTime() > GITHUB_PROOF_MAX_AGE_MS ||
        checkedAt.getTime() > now().getTime() + 5_000) refuse('github-admin-required', 'Current GitHub admin access to this repository is required')
    return { ...github, checkedAt }
  }

  // `work` gets the client and a state object; setting state.broken discards the connection (it may still hold a lock).
  async function withRepoLock(repoId, work) {
    const client = await pool.connect(), state = { broken: false }
    try {
      await lockOrRefuse(client, 'select pg_advisory_lock($1::bigint)', [repoId])
      try { return await work(client, state) }
      finally {
        try { await client.query('select pg_advisory_unlock($1::bigint)', [repoId]) } catch { state.broken = true }
      }
    } finally { client.release(state.broken || undefined) }
  }

  // A one-use challenge for the repository's active payout wallet, issued only to a current admin.
  // A bounded number may be live at once, so issuance cannot fill the table.
  async function requestChallenge({ githubRepoId }) {
    const repoId = repoIdOf(githubRepoId)
    if (!(await claimWindow(pool, repoId))) refuse('claims-not-open', 'Claims are not open for this repository yet')
    const github = await currentAdmin(repoId)
    return withRepoLock(repoId, async client => {
      const beneficiary = await resolvePayoutRecipient(client, repoId)
      const { rows: [live] } = await client.query(`select count(*)::int as n from claim_payout_challenges
        where github_repo_id = $1 and consumed_at is null and expires_at > now()`, [repoId])
      if (live.n >= MAX_LIVE_CHALLENGES) refuse('too-many-challenges', 'Too many open claims; wait a few minutes and try again')
      const nonce = randomBytes(24).toString('hex'), expiresAt = new Date(now().getTime() + CLAIM_CHALLENGE_LIFETIME_MS)
      await client.query(`insert into claim_payout_challenges (nonce, github_repo_id, github_user_id, wallet, expires_at)
        values ($1, $2, $3, $4, $5)`, [nonce, repoId, String(github.githubUserId), beneficiary.wallet, expiresAt])
      return { githubRepoId: repoId, wallet: beneficiary.wallet, nonce, expiresAt,
        message: claimMessage({ githubRepoId: repoId, wallet: beneficiary.wallet, nonce, expiresAt }) }
    })
  }

  // Checks the challenge and the payout wallet's signature without using them up (consumeChallenge does).
  async function verifyChallenge(client, { repoId, githubUserId, wallet, nonce, signature }) {
    if (typeof nonce !== 'string' || !/^[0-9a-f]{48}$/.test(nonce)) refuse('invalid-challenge', 'Invalid claim challenge')
    let bytes
    try { bytes = Buffer.from(bs58.decode(signature)) } catch { refuse('invalid-signature', 'Invalid wallet signature') }
    if (bytes.length !== 64) refuse('invalid-signature', 'Invalid wallet signature')
    const { rows: [challenge] } = await client.query(`select github_repo_id::text as "repoId", github_user_id::text as "userId", wallet,
      expires_at as "expiresAt", consumed_at as "consumedAt" from claim_payout_challenges where nonce = $1`, [nonce])
    if (!challenge || challenge.consumedAt) refuse('challenge-used', 'This claim challenge was already used or never issued')
    if (challenge.repoId !== repoId || challenge.userId !== String(githubUserId) || challenge.wallet !== wallet ||
        new Date(challenge.expiresAt) <= now()) refuse('challenge-mismatch', 'The claim challenge is expired or does not match')
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' })
    const message = claimMessage({ githubRepoId: repoId, wallet, nonce, expiresAt: challenge.expiresAt })
    if (!verifySignature(null, Buffer.from(message, 'utf8'), key, bytes)) refuse('invalid-signature', 'The payout wallet did not sign this claim')
    return { nonce, signature: bs58.encode(bytes) }
  }

  // Uses up the challenge with its signature in one guarded statement, so neither is ever used twice.
  async function consumeChallenge(client, { nonce, signature }) {
    try {
      const { rowCount } = await client.query(`update claim_payout_challenges set consumed_at = now(), signature = $2
        where nonce = $1 and consumed_at is null and expires_at > now()`, [nonce, signature])
      if (rowCount !== 1) refuse('challenge-used', 'This claim challenge was already used')
    } catch (error) {
      if (error instanceof PayoutRefused) throw error
      if (error?.code === '23505') refuse('challenge-used', 'This signature was already used')
      throw error
    }
  }

  // Order: cheap refusals first, the GitHub check and the challenge's use last, so a refused claim rarely costs a signature.
  async function claim({ githubRepoId, nonce, signature }) {
    const repoId = repoIdOf(githubRepoId)
    if (!(await payoutControls(pool)).enabled) refuse('payouts-off', 'Builder payouts are switched off')
    return withRepoLock(repoId, async (client, state) => {
      if (!(await claimWindow(client, repoId))) refuse('claims-not-open', 'Claims are not open for this repository yet')
      const { rows: pending } = await client.query("select claim_signature from repo_claims where github_repo_id = $1 and status = 'pending' limit 1", [repoId])
      if (pending.length) refuse('claim-pending', 'A previous claim for this repository is still settling')
      if ((await builderCollectionState(client, BigInt(repoId))).pending) refuse('claim-pending', 'A platform collection for this repository is still settling')
      const beneficiary = await resolvePayoutRecipient(client, repoId)
      await lockOrRefuse(client, 'select pg_advisory_lock($1, $2)', DAILY_CAP_LOCK)
      try {
        return await pay(client, { repoId, recipient: beneficiary.wallet, nonce, signature })
      } finally {
        try { await client.query('select pg_advisory_unlock($1, $2)', DAILY_CAP_LOCK) } catch { state.broken = true }
      }
    })
  }

  async function pay(client, { repoId, recipient, nonce, signature }) {
    // Read under the daily lock, so caps lowered during an incident apply to claims already queued.
    const controls = await payoutControls(client)
    if (!controls.enabled) refuse('payouts-off', 'Builder payouts are switched off')
    const owed = await owedLamports(client, repoId)
    if (owed <= 0n) refuse('nothing-owed', 'Nothing is owed to this repository')
    const remaining = controls.daily - await dailyUsed(client)
    const amount = [owed, controls.maxClaim, remaining].reduce((a, b) => (a < b ? a : b))
    if (remaining <= 0n || amount < MIN_PAYOUT_LAMPORTS && remaining < MIN_PAYOUT_LAMPORTS) refuse('daily-cap', 'Today\'s payout limit is reached; try again later')
    if (amount < MIN_PAYOUT_LAMPORTS) refuse('below-minimum', 'The amount owed is below the minimum payout; let more fees accrue')
    const [payerBalance, recipientBalance, rentMinimum] = await Promise.all([chain.balance(payer), chain.balance(recipient), chain.rentMinimum()])
    if (payerBalance > PAYOUT_WALLET_CAP_LAMPORTS) refuse('payout-wallet-over-cap', 'The payout wallet holds more than its 2 SOL cap')
    if (payerBalance - amount - NETWORK_FEE_RESERVE_LAMPORTS < rentMinimum) refuse('payout-wallet-low', 'The payout wallet needs a refill')
    if (recipientBalance === 0n && amount < rentMinimum) refuse('below-new-wallet-minimum', 'The amount is below what a new wallet must receive')
    const github = await currentAdmin(repoId)
    const proof = await verifyChallenge(client, { repoId, githubUserId: github.githubUserId, wallet: recipient, nonce, signature })
    const latest = await chain.latestBlockhash()
    const transaction = new Transaction({ feePayer: payoutSigner.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight })
      .add(SystemProgram.transfer({ fromPubkey: payoutSigner.publicKey, toPubkey: new PublicKey(recipient), lamports: amount }))
    transaction.sign(payoutSigner)
    const simulated = await chain.simulate(transaction)
    if (simulated) refuse('preflight-failed', `Payout preflight failed: ${JSON.stringify(simulated)}`)
    if (!(await payoutControls(client)).enabled) refuse('payouts-off', 'Builder payouts were switched off')
    if (now().getTime() - github.checkedAt.getTime() > GITHUB_PROOF_MAX_AGE_MS) refuse('github-admin-required', 'The GitHub check expired; claim again')
    await consumeChallenge(client, proof)
    const claimSignature = bs58.encode(transaction.signature), bytes = transaction.serialize()
    await client.query(`insert into repo_claims (github_repo_id, beneficiary_wallet, amount_base_units, damm_amount_base_units, asset,
        claim_signature, status, signed_transaction, last_valid_block_height, payout_source, payout_nonce)
      values ($1, $2, $3, 0, $4, $5, 'pending', $6, $7, 'payout-wallet', $8)`,
    [repoId, recipient, String(amount), SOL, claimSignature, bytes.toString('base64'), String(latest.lastValidBlockHeight), nonce])
    await chain.broadcast(bytes, { signature: claimSignature, lastValidBlockHeight: latest.lastValidBlockHeight })
    const failed = await chain.finalize(claimSignature, latest)
    if (failed) {
      await client.query("update repo_claims set status = 'aborted', resolved_at = now(), resolution_reason = 'Finalized transaction failed' where claim_signature = $1 and status = 'pending'", [claimSignature])
      refuse('payout-failed', 'The payout transaction failed on chain; nothing was paid')
    }
    return settle(client, { claimSignature, recipient, amount, repoId })
  }

  async function settle(client, { claimSignature, recipient, amount, repoId }) {
    const receipt = await chain.receipt(claimSignature)
    if (!checkPayoutReceipt(receipt, { payer, recipient, amount })) {
      // Left pending: it blocks further claims for the repository until reviewed. Never abort it by hand: only
      // createPayoutRecovery may abort, and only after the transfer is proven expired and unlanded.
      throw Error('Payout receipt does not show exactly the approved transfer; review required')
    }
    await client.query("update repo_claims set status = 'settled', settled_at = now() where claim_signature = $1 and status = 'pending'", [claimSignature])
    return { status: 'settled', githubRepoId: repoId, signature: claimSignature, amountLamports: amount, wallet: recipient }
  }

  return { requestChallenge, claim }
}

async function lockOrRefuse(client, statement, values) {
  await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`)
  try { await client.query(statement, values) }
  catch (error) {
    if (error?.code === '55P03') refuse('busy', 'Another payout is in progress; try again in a minute')
    throw error
  } finally { await client.query('reset lock_timeout') }
}

// Pending payout-wallet claims after a crash or an RPC failure: settle on the exact finalized receipt, abort a transfer
// that failed on chain, rebroadcast the identical signed transfer while it can still land, and abort only once it is
// proven expired and unlanded. Anything else stays pending for review. createClaimRecovery leaves these rows alone.
export function createPayoutRecovery({ pool, chain }) {
  return { runOnce: async () => {
    const { rows } = await pool.query(`select github_repo_id::text as repo, claim_signature as signature, beneficiary_wallet as recipient,
      amount_base_units::text as amount, signed_transaction as signed, last_valid_block_height::text as expiry
      from repo_claims where status = 'pending' and payout_source = 'payout-wallet'`)
    const results = []
    for (const row of rows) {
      const client = await pool.connect()
      let broken = false
      try {
        const { rows: [lock] } = await client.query('select pg_try_advisory_lock($1::bigint) as locked', [row.repo])
        if (!lock.locked) { results.push({ githubRepoId: row.repo, status: 'busy' }); continue }
        try { results.push({ githubRepoId: row.repo, signature: row.signature, status: await recoverOne(client, chain, row) }) }
        finally { try { await client.query('select pg_advisory_unlock($1::bigint)', [row.repo]) } catch { broken = true } }
      } catch (error) {
        console.error('payout recovery needs review', { repo: row.repo, error: error?.message })
        results.push({ githubRepoId: row.repo, status: 'review' })
      } finally { client.release(broken || undefined) }
    }
    return results
  } }
}

async function recoverOne(client, chain, row) {
  const bytes = Buffer.from(row.signed, 'base64'), payer = Transaction.from(bytes).feePayer.toBase58()
  const status = await chain.status(row.signature)
  if (status?.confirmationStatus === 'finalized') {
    if (status.err) {
      await client.query("update repo_claims set status = 'aborted', resolved_at = now(), resolution_reason = 'Finalized transaction failed' where claim_signature = $1 and status = 'pending'", [row.signature])
      return 'aborted'
    }
    if (!checkPayoutReceipt(await chain.receipt(row.signature), { payer, recipient: row.recipient, amount: BigInt(row.amount) })) return 'review'
    await client.query("update repo_claims set status = 'settled', settled_at = now() where claim_signature = $1 and status = 'pending'", [row.signature])
    return 'settled'
  }
  if (status) return 'pending'
  if (await chain.expiredUnlanded(row.signature, row.expiry)) {
    await client.query("update repo_claims set status = 'aborted', resolved_at = now(), resolution_reason = 'Signed blockhash expired without chain evidence' where claim_signature = $1 and status = 'pending'", [row.signature])
    return 'aborted'
  }
  await chain.rebroadcast(bytes)
  return 'pending'
}
