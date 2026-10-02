import bs58 from 'bs58'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { parseReferrer } from './referral.mjs'
import { mapLimited } from './builder-queue.mjs'
import { CONFIRM_CHARACTERS, PASTED_ADDRESS_HOLD_MS, PAYOUT_ADDRESS_WARNING, confirmsAddress } from './payout-address-policy.mjs'
import { assertAuthoritySource } from './market-identity.mjs'

export { PASTED_ADDRESS_HOLD_MS, PAYOUT_ADDRESS_WARNING }

// Pasted payout addresses (drizzle/0048_pasted_payout_address.sql). A verified GitHub admin can set a repository's payout
// address by pasting it instead of signing with the wallet. The address is stored as a pending request and becomes the
// repository's binding in repo_beneficiaries, the only recipient any payout path reads, once PASTED_ADDRESS_HOLD_MS has
// passed. Until then the previous binding keeps receiving claims, any current admin can cancel the request, and a
// wallet-signature binding (src/wallet-binding.mjs) replaces it. Every change runs under the repository's advisory lock,
// the same lock the claim path holds while it resolves the recipient.
// A Hugging Face model market works the same way with a Hugging Face authority (verifyAuthority.source 'huggingface',
// app/lib/hf-session.mjs): the model's current owner or an admin of its organization, recorded in model_verifications
// (drizzle/0051_model_authority.sql). The request names that user and the owner's _id, and its binding inherits both.

export const MAX_BATCH_REPOSITORIES = 100
const AUTHORITY_MAX_AGE_MS = 60_000
const VERIFICATION_MAX_AGE = '5 minutes'
// Requests per repository per hour; each one can email the repository's builders.
const MAX_REQUESTS_PER_HOUR = 5
const REPO_ID = /^[1-9]\d{0,18}$/
const SUBJECT = /^[0-9a-f]{24}$/

export class PayoutAddressError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'PayoutAddressError'
    this.code = code
    this.status = status
  }
}
const fail = (code, message, status) => { throw new PayoutAddressError(code, message, status) }

// SOL sent to a program, sysvar, mint or the incinerator is lost or stuck. Several of these (the System Program among
// them) are valid on-curve keys, so the curve check alone would accept them.
export const KNOWN_PROGRAM_ADDRESSES = new Set([
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'ComputeBudget111111111111111111111111111111', 'Stake11111111111111111111111111111111111111', 'StakeConfig11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111', 'Config1111111111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111', 'BPFLoaderUpgradeab1e11111111111111111111111', 'LoaderV411111111111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111', 'AddressLookupTab1e1111111111111111111111111', 'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111', 'Secp256r1SigVerify1111111111111111111111111', 'Feature111111111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111', 'ZkTokenProof1111111111111111111111111111111', 'ZkE1Gama1Proof11111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111', 'SysvarEpochSchedu1e111111111111111111111111',
  'SysvarFees111111111111111111111111111111111', 'SysvarRecentB1ockHashes11111111111111111111', 'SysvarRewards111111111111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111', 'SysvarS1otHistory11111111111111111111111111', 'SysvarStakeHistory1111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111', 'SysvarEpochRewards1111111111111111111111111', 'SysvarLastRestartS1ot1111111111111111111111',
  'Sysvar1111111111111111111111111111111111111',
  // Native SOL mints (wrapped SOL, Token-2022).
  'So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP',
  // Programs repo.ing markets use or route through: Meteora DBC, DAMM v2, DAMM v1, locker, vault; Metaplex metadata;
  // and the large DEX/launchpad programs a builder might copy from an explorer by mistake.
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn', '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
])

const NOT_AN_ADDRESS = 'That is not a Solana address. Paste the full address from your wallet app (32 to 44 letters and numbers).'

// Server-side validation of the pasted text. reserved: platform signer addresses, which must never receive builder payouts.
export function parsePayoutAddress(value, { reserved = [] } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('ADDRESS_REQUIRED', 'Paste the Solana address that should receive payouts.')
  const text = value.trim()
  if (text.length < 32 || text.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) fail('NOT_BASE58', NOT_AN_ADDRESS)
  let bytes
  try { bytes = bs58.decode(text) } catch { fail('NOT_BASE58', NOT_AN_ADDRESS) }
  if (bytes.length !== 32) fail('WRONG_LENGTH', 'That is not a Solana address: it does not decode to a 32-byte public key. Copy it again from your wallet app.')
  const key = new PublicKey(bytes)
  if (key.toBase58() !== text) fail('NOT_BASE58', NOT_AN_ADDRESS)
  if (KNOWN_PROGRAM_ADDRESSES.has(text)) fail('PROGRAM_ADDRESS', 'That is a Solana program or system address, not a wallet. SOL sent there cannot be recovered.')
  if (reserved.some(address => address && new PublicKey(address).equals(key))) {
    fail('PLATFORM_ADDRESS', 'That address belongs to repo.ing. Paste the address of a wallet you control.')
  }
  // The referral module's check: a canonical, on-curve wallet key. Program-derived addresses have no private key.
  if (!parseReferrer(text)) fail('OFF_CURVE', 'That is a program-derived address (PDA), not a wallet: no one holds a key for it. Paste the address of a wallet you control.')
  return key
}

export function assertConfirmation(address, typed) {
  if (!confirmsAddress(address, typed)) {
    fail('CONFIRMATION_MISMATCH', `The last ${CONFIRM_CHARACTERS} characters you typed do not match the address. Check them in your wallet app and type them again (capital letters matter).`)
  }
}

// One finalized read. A missing account is a fresh wallet; an existing one must be a plain System-owned wallet. A failed
// read is refused, never guessed.
export async function checkPayoutAccount(connection, key) {
  let info
  try { info = await connection.getAccountInfo(key, 'finalized') }
  catch { fail('ACCOUNT_UNAVAILABLE', 'Solana could not be reached to check this address. Nothing was saved; try again in a minute.', 503) }
  if (info === null) return { exists: false }
  if (!info || typeof info !== 'object' || !info.owner) {
    fail('ACCOUNT_UNAVAILABLE', 'Solana could not be reached to check this address. Nothing was saved; try again in a minute.', 503)
  }
  const owner = new PublicKey(info.owner)
  if (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) {
    fail('NOT_A_WALLET', 'That address is a token account or mint, not a wallet. Paste your wallet’s own SOL address.')
  }
  if (info.executable || !owner.equals(SystemProgram.programId)) {
    fail('NOT_A_WALLET', 'That address belongs to a program, not a wallet. Paste the address of a wallet you control.')
  }
  if (info.data?.length) fail('NOT_A_WALLET', 'That address is a special system account (for example a nonce account), not a wallet.')
  return { exists: true, lamports: BigInt(info.lamports ?? 0) }
}

export const pendingHoldMessage = activeAt =>
  `This repository's pasted payout address is in its 48-hour hold until ${new Date(activeAt).toISOString()}. Claims open then.`

const repoIdOf = value => {
  const id = String(value ?? '')
  if (!REPO_ID.test(id)) fail('INVALID_REPOSITORY', 'Invalid repository.')
  return id
}
const byRepoId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)

// A pending request whose hold has passed becomes the repository's binding: a new bound_at, so any review sealed for the
// previous recipient stops matching (src/claim-review.mjs). If the binding changed after the request was stored (a wallet
// signature, which normally supersedes the request itself), the newer binding wins instead; replaces_bound_at makes that
// exact, with no comparison between the app's and the database's clocks. The caller holds the repository's advisory lock
// inside an open transaction.
// A model market's request (drizzle/0051_model_authority.sql) carries its Hugging Face authority into the binding. Those
// columns are read through to_jsonb and GitHub requests keep exactly the 0048 statements, so this pass (which the worker
// runs, and worker deploys do not migrate) also works on a database the 0051 migration has not reached yet.
export async function activateDueWithin(client, repoId) {
  const { rows: [due] } = await client.query(`select r.id::text as id, r.wallet, r.requested_by_github_user_id::text as "requestedBy",
      to_jsonb(r) ->> 'authority_source' as "authoritySource", to_jsonb(r) ->> 'requested_by_subject' as "requestedBySubject",
      to_jsonb(r) ->> 'requested_by_owner_subject' as "requestedByOwnerSubject",
      b.wallet as "currentWallet", b.github_user_id::text as "currentUser", to_jsonb(b) ->> 'authority_subject' as "currentSubject",
      (b.github_repo_id is not null and b.bound_at is distinct from r.replaces_bound_at) as "newerBinding"
    from payout_address_requests r left join repo_beneficiaries b on b.github_repo_id = r.github_repo_id
    where r.github_repo_id = $1 and r.status = 'pending' and r.active_at <= now()
    for update of r`, [repoId])
  if (!due) return null
  const model = due.authoritySource === 'huggingface'
  if (due.newerBinding) {
    if (model) {
      await client.query(`update payout_address_requests set status = 'superseded', resolved_at = now(), resolved_by_subject = $2,
        resolution_reason = 'A newer payout binding replaced it' where id = $1`, [due.id, due.currentSubject])
      await client.query(`insert into payout_address_events(request_id, github_repo_id, event, actor_subject, wallet, previous_wallet)
        values ($1, $2, 'superseded', $3, $4, $5)`, [due.id, repoId, due.currentSubject, due.wallet, due.currentWallet])
    } else {
      await client.query(`update payout_address_requests set status = 'superseded', resolved_at = now(), resolved_by_github_user_id = $2,
      resolution_reason = 'A newer payout binding replaced it' where id = $1`, [due.id, due.currentUser])
      await client.query(`insert into payout_address_events(request_id, github_repo_id, event, github_user_id, wallet, previous_wallet)
      values ($1, $2, 'superseded', $3, $4, $5)`, [due.id, repoId, due.currentUser, due.wallet, due.currentWallet])
    }
    return { status: 'superseded', repoId, requestId: due.id }
  }
  await client.query(`update payout_address_requests set status = 'activated', resolved_at = now() where id = $1`, [due.id])
  if (model) {
    // The binding inherits the request's Hugging Face user and the model owner's _id (claims refuse it after a transfer).
    await client.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet, bound_at, method, payout_request_id,
        authority_source, authority_subject, authority_owner_subject)
      values ($1, null, $2, now(), 'pasted', $3, 'huggingface', $4, $5)
      on conflict (github_repo_id) do update set github_user_id = excluded.github_user_id, wallet = excluded.wallet,
        bound_at = excluded.bound_at, method = excluded.method, payout_request_id = excluded.payout_request_id,
        authority_source = excluded.authority_source, authority_subject = excluded.authority_subject,
        authority_owner_subject = excluded.authority_owner_subject`,
    [repoId, due.wallet, due.id, due.requestedBySubject, due.requestedByOwnerSubject])
  } else {
    await client.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet, bound_at, method, payout_request_id)
    values ($1, $2, $3, now(), 'pasted', $4)
    on conflict (github_repo_id) do update set github_user_id = excluded.github_user_id, wallet = excluded.wallet,
      bound_at = excluded.bound_at, method = excluded.method, payout_request_id = excluded.payout_request_id`,
    [repoId, due.requestedBy, due.wallet, due.id])
  }
  await client.query(`insert into payout_address_events(request_id, github_repo_id, event, wallet, previous_wallet)
    values ($1, $2, 'activated', $3, $4)`, [due.id, repoId, due.wallet, due.currentWallet])
  return { status: 'activated', repoId, requestId: due.id, wallet: due.wallet, previousWallet: due.currentWallet }
}

// For a caller that already holds the repository's session lock (the claim path): one transaction, re-entering that lock.
export async function activateDuePayoutAddress(client, repoId) {
  const id = repoIdOf(repoId)
  await client.query('begin')
  try {
    await client.query('select pg_advisory_xact_lock($1::bigint)', [id])
    const result = await activateDueWithin(client, id)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
}

export async function pendingPayoutAddress(executor, repoId) {
  const { rows: [row] } = await executor.query(`select id::text as id, wallet, requested_at as "requestedAt", active_at as "activeAt",
      requested_by_login as "requestedByLogin" from payout_address_requests where github_repo_id = $1 and status = 'pending'`, [repoIdOf(repoId)])
  return row ?? null
}

// The claim path's recipient (src/claim.mjs), resolved while the caller holds the repository's session lock: a due pasted
// address is activated first; then only the active binding is returned. A repository whose only address is still in its
// hold is refused with the time claims open. The binding's authority comes with it (a model market's names the owner).
export async function resolvePayoutRecipient(client, repoId) {
  const id = repoIdOf(repoId)
  await activateDuePayoutAddress(client, id)
  const { rows: [binding] } = await client.query(`select wallet, bound_at as "boundAt", method, github_user_id::text as "githubUserId",
      to_jsonb(repo_beneficiaries) ->> 'authority_source' as "authoritySource",
      to_jsonb(repo_beneficiaries) ->> 'authority_owner_subject' as "authorityOwnerSubject"
    from repo_beneficiaries where github_repo_id = $1`, [id])
  if (binding) return binding
  const pending = await pendingPayoutAddress(client, id)
  throw new Error(pending ? pendingHoldMessage(pending.activeAt) : 'Repository has no bound beneficiary')
}

// Worker pass, and page loads before they show a destination: activate every due request. A repository whose lock is
// busy (a claim or binding change in progress) is skipped; that holder activates it itself or a later pass does.
export async function activateDuePayoutAddresses(pool, { repoIds = null, limit = 50 } = {}) {
  const ids = repoIds ? repoIds.map(repoIdOf) : null
  if (ids && !ids.length) return []
  const { rows } = await pool.query(`select github_repo_id::text as "repoId" from payout_address_requests
    where status = 'pending' and active_at <= now() and ($2::bigint[] is null or github_repo_id = any($2::bigint[]))
    order by active_at limit $1`, [limit, ids])
  const results = []
  for (const { repoId } of rows) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const { rows: [lock] } = await client.query('select pg_try_advisory_xact_lock($1::bigint) as locked', [repoId])
      const result = lock.locked ? await activateDueWithin(client, repoId) : null
      await client.query('commit')
      results.push(lock.locked ? result ?? { status: 'none', repoId } : { status: 'busy', repoId })
    } catch (error) {
      await client.query('rollback').catch(() => {})
      console.error('payout address activation needs review', { repo: repoId, error: error?.message })
      results.push({ status: 'error', repoId })
    } finally { client.release() }
  }
  return results
}

// Active binding and waiting request per repository, for the claim page and the Builders dashboard.
export async function readPayoutDestinations(pool, repoIds) {
  const ids = repoIds.map(repoIdOf)
  if (!ids.length) return new Map()
  const { rows } = await pool.query(`select x.id::text as "repoId", b.wallet, b.bound_at as "boundAt", b.method,
      p.id::text as "pendingId", p.wallet as "pendingWallet", p.requested_at as "requestedAt", p.active_at as "activeAt",
      p.requested_by_login as "requestedByLogin"
    from unnest($1::bigint[]) as x(id)
    left join repo_beneficiaries b on b.github_repo_id = x.id
    left join payout_address_requests p on p.github_repo_id = x.id and p.status = 'pending'`, [ids])
  return new Map(rows.map(row => [row.repoId, {
    active: row.wallet ? { wallet: row.wallet, method: row.method, boundAt: new Date(row.boundAt).toISOString() } : null,
    pending: row.pendingId ? { id: row.pendingId, wallet: row.pendingWallet, requestedAt: new Date(row.requestedAt).toISOString(),
      activeAt: new Date(row.activeAt).toISOString(), requestedByLogin: row.requestedByLogin } : null,
  }]))
}

// verifyAuthority: the fresh GitHub admin check of the builder routes (app/lib/github-session.mjs), at most a minute old,
// for this repository and the signed-in user. → the actor: who the request, cancel or audit event names.
async function authorize(repoId, verifyAuthority, now) {
  if (typeof verifyAuthority !== 'function') fail('GITHUB_REQUIRED', 'Current GitHub admin permission required', 403)
  if (verifyAuthority.source === 'huggingface') return authorizeModel(repoId, verifyAuthority, now)
  const github = await verifyAuthority({ githubRepoId: BigInt(repoId) })
  const checkedAt = new Date(github?.verifiedAt).getTime()
  if (github?.verified !== true || github.permission !== 'admin' || String(github.githubRepoId) !== repoId ||
      !REPO_ID.test(String(github.githubUserId ?? '')) || !Number.isFinite(checkedAt) ||
      now() - checkedAt > AUTHORITY_MAX_AGE_MS || checkedAt > now() + 5_000) {
    fail('GITHUB_REQUIRED', 'Current GitHub admin permission required', 403)
  }
  const login = typeof github.githubLogin === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(github.githubLogin) ? github.githubLogin : `user ${github.githubUserId}`
  return { source: 'github', userId: String(github.githubUserId), login, subject: null, ownerSubject: null }
}

// A model market: the fresh Hugging Face check (src/hf-verification.mjs), at most a minute old, naming the signed-in user
// and the model's current owner. Its own refusals (model moved, private, not the owner) pass through as they are.
async function authorizeModel(repoId, verifyAuthority, now) {
  const result = await verifyAuthority({ githubRepoId: BigInt(repoId) })
  const checkedAt = new Date(result?.verifiedAt).getTime()
  if (result?.verified !== true || result.source !== 'huggingface' || result.permission !== 'admin' || String(result.githubRepoId) !== repoId ||
      !SUBJECT.test(result.subject ?? '') || !SUBJECT.test(result.ownerSubject ?? '') || !Number.isFinite(checkedAt) ||
      now() - checkedAt > AUTHORITY_MAX_AGE_MS || checkedAt > now() + 5_000) {
    fail('HF_REQUIRED', 'Current Hugging Face owner permission required', 403)
  }
  const login = typeof result.username === 'string' && /^[\w.-]{1,96}$/.test(result.username) ? result.username : `Hugging Face user ${result.subject}`
  return { source: 'huggingface', userId: null, login, subject: result.subject, ownerSubject: result.ownerSubject }
}

// The same recorded admin verification the wallet-signature binding requires, checked inside the transaction.
async function requireRecentAdmin(client, repoId, userId) {
  const { rows } = await client.query(`select 1 from repo_verifications where github_repo_id = $1 and github_user_id = $2
    and permission = 'admin' and verified_at >= now() - interval '${VERIFICATION_MAX_AGE}' limit 1`, [repoId, userId])
  if (!rows.length) fail('GITHUB_REQUIRED', 'Recent GitHub admin verification required', 403)
}

// The actor's recorded verification: GitHub's above, or a model_verifications row for the same user and current owner.
async function requireRecentAuthority(client, repoId, actor) {
  if (actor.source !== 'huggingface') return requireRecentAdmin(client, repoId, actor.userId)
  const { rows } = await client.query(`select 1 from model_verifications where github_repo_id = $1 and subject = $2 and owner_subject = $3
    and verified_at >= now() - interval '${VERIFICATION_MAX_AGE}' limit 1`, [repoId, actor.subject, actor.ownerSubject])
  if (!rows.length) fail('HF_REQUIRED', 'Recent Hugging Face owner verification required', 403)
}

// A claim holds its repository's lock until the payout settles. A paste or cancel waits a bounded time for it, so it
// never pins a database connection behind a long claim.
async function inRepoLocks(pool, repoIds, work, lockTimeoutMs) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(`set local lock_timeout = ${Math.max(1, Math.trunc(lockTimeoutMs))}`)
    for (const id of [...repoIds].sort(byRepoId)) await client.query('select pg_advisory_xact_lock($1::bigint)', [id])
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    if (error?.code === '55P03') {
      fail('BUSY', 'A claim or another payout address change is in progress for this repository. Nothing was saved; try again in a minute.', 409)
    }
    throw error
  } finally { client.release() }
}

// The database stamps requested_at, raises active_at to at least 48 hours after it and records the binding the request
// would replace (trigger start_payout_address_request); a longer PASTED_ADDRESS_HOLD_MS is kept as given.
async function insertRequest(client, { repoId, wallet, actor, previousWallet }) {
  const { rows: [created] } = await client.query(`insert into payout_address_requests(github_repo_id, wallet, requested_by_github_user_id,
      requested_by_login, active_at, authority_source, requested_by_subject, requested_by_owner_subject)
    values ($1, $2, $3, $4, clock_timestamp() + $5::bigint * interval '1 millisecond', $6, $7, $8)
    returning id::text as id, wallet, requested_at as "requestedAt", active_at as "activeAt"`,
  [repoId, wallet, actor.userId, actor.login, PASTED_ADDRESS_HOLD_MS, actor.source, actor.subject, actor.ownerSubject])
  await client.query(`insert into payout_address_events(request_id, github_repo_id, event, github_user_id, github_login, actor_subject, wallet, previous_wallet)
    values ($1, $2, 'requested', $3, $4, $5, $6, $7)`, [created.id, repoId, actor.userId, actor.login, actor.subject, wallet, previousWallet])
  return { id: created.id, repoId, wallet, requestedAt: created.requestedAt.toISOString(), activeAt: created.activeAt.toISOString() }
}

// Checked before any GitHub or Solana call, then again under the lock.
async function assertRequestRate(executor, repoIds) {
  const { rows } = await executor.query(`select github_repo_id from payout_address_requests
    where github_repo_id = any($1::bigint[]) and requested_at > now() - interval '1 hour'
    group by github_repo_id having count(*) >= $2 limit 1`, [repoIds, MAX_REQUESTS_PER_HOUR])
  if (rows.length) fail('RATE_LIMITED', 'Too many payout address changes for this repository in the last hour. Try again later.', 429)
}

// reserved: repo.ing's own wallet addresses (never a builder's payout address). lockTimeoutMs: how long a change waits
// for the repository's lock before answering BUSY.
export function createPayoutAddresses({ pool, connection, reserved = [], now = Date.now, lockTimeoutMs = 10_000 }) {
  const prepare = (address, confirm) => {
    const key = parsePayoutAddress(address, { reserved })
    assertConfirmation(key.toBase58(), confirm)
    return key
  }

  // One repository: becomes pending; an existing binding keeps receiving claims until it activates. A newer paste
  // replaces an older waiting one (which is recorded as superseded); the hold starts again. The authority's source must be
  // the market's (src/market-identity.mjs; a verifyAuthority without one is GitHub's), checked before any other call.
  async function request({ githubRepoId, address, confirm, verifyAuthority }) {
    const repoId = repoIdOf(githubRepoId)
    assertAuthoritySource(verifyAuthority, repoId)
    const key = prepare(address, confirm), wallet = key.toBase58()
    await assertRequestRate(pool, [repoId])
    const actor = await authorize(repoId, verifyAuthority, now)
    const { userId, login } = actor
    await checkPayoutAccount(connection, key)
    return inRepoLocks(pool, [repoId], async client => {
      await requireRecentAuthority(client, repoId, actor)
      await activateDueWithin(client, repoId)
      const { rows: [active] } = await client.query(`select wallet, github_user_id::text as "githubUserId",
          to_jsonb(repo_beneficiaries) ->> 'authority_owner_subject' as "ownerSubject"
        from repo_beneficiaries where github_repo_id = $1 for update`, [repoId])
      const { rows: [pending] } = await client.query(`select id::text as id, wallet, requested_by_github_user_id::text as "requestedBy",
          to_jsonb(payout_address_requests) ->> 'requested_by_owner_subject' as "ownerSubject"
        from payout_address_requests where github_repo_id = $1 and status = 'pending' for update`, [repoId])
      // On a model market, a binding or request made for a previous owner does not count: the current owner may set the same
      // address again, under their own authority (claims refuse the stale one meanwhile).
      const current = row => actor.source !== 'huggingface' || row.ownerSubject === actor.ownerSubject
      if (active?.wallet === wallet && current(active)) fail('ALREADY_ACTIVE', 'That address already receives this repository’s payouts.', 409)
      if (pending?.wallet === wallet && current(pending)) fail('ALREADY_PENDING', 'That address is already waiting to become this repository’s payout address.', 409)
      await assertRequestRate(client, [repoId])
      if (pending) {
        await client.query(`update payout_address_requests set status = 'superseded', resolved_at = now(), resolved_by_github_user_id = $2,
          resolved_by_subject = $3, resolution_reason = 'Replaced by a newer pasted address' where id = $1`, [pending.id, userId, actor.subject])
        await client.query(`insert into payout_address_events(request_id, github_repo_id, event, github_user_id, github_login, actor_subject, wallet, previous_wallet)
          values ($1, $2, 'superseded', $3, $4, $5, $6, $7)`, [pending.id, repoId, userId, login, actor.subject, pending.wallet, active?.wallet ?? null])
      }
      const created = await insertRequest(client, { repoId, wallet, actor, previousWallet: active?.wallet ?? null })
      // Change notices go to GitHub builders' reminder emails; Hugging Face users have none (every id here is null then).
      return { ...created, requestedByLogin: login, previousWallet: active?.wallet ?? null, replacedWallet: pending?.wallet ?? null,
        notify: [...new Set([userId, active?.githubUserId, pending?.requestedBy].filter(Boolean))] }
    }, lockTimeoutMs)
  }

  // Builders dashboard: one address for repositories that have neither a payout address nor a waiting one. All or
  // nothing, like the batch wallet-signature setup.
  async function requestBatch({ githubRepoIds, address, confirm, verifyAuthority }) {
    if (!Array.isArray(githubRepoIds) || !githubRepoIds.length || githubRepoIds.length > MAX_BATCH_REPOSITORIES) {
      fail('INVALID_REPOSITORIES', `Choose up to ${MAX_BATCH_REPOSITORIES} repositories.`)
    }
    const ids = githubRepoIds.map(repoIdOf)
    if (new Set(ids).size !== ids.length) fail('INVALID_REPOSITORIES', `Choose up to ${MAX_BATCH_REPOSITORIES} distinct repositories.`)
    // The dashboard is GitHub's; a model market's address is set on its own claim page.
    if (verifyAuthority?.source === 'huggingface') fail('INVALID_REPOSITORIES', 'Set a model’s payout address on its claim page.')
    for (const id of ids) assertAuthoritySource(verifyAuthority, id)
    const key = prepare(address, confirm), wallet = key.toBase58()
    await assertRequestRate(pool, ids)
    const authorities = await mapLimited(ids, 3, id => authorize(id, verifyAuthority, now))
    if (new Set(authorities.map(a => a.userId)).size !== 1) fail('GITHUB_REQUIRED', 'Current GitHub admin permission required', 403)
    const actor = authorities[0], { userId, login } = actor
    await checkPayoutAccount(connection, key)
    return inRepoLocks(pool, ids, async client => {
      for (const repoId of [...ids].sort(byRepoId)) {
        await requireRecentAdmin(client, repoId, userId)
        await activateDueWithin(client, repoId)
        const { rows: [taken] } = await client.query(`select exists(select 1 from repo_beneficiaries where github_repo_id = $1) as bound,
          exists(select 1 from payout_address_requests where github_repo_id = $1 and status = 'pending') as waiting`, [repoId])
        if (taken.bound || taken.waiting) {
          fail('ALREADY_SET', 'A payout address was set or requested for one of these repositories. Refresh; change existing ones on their claim pages.', 409)
        }
      }
      await assertRequestRate(client, ids)
      const requests = []
      for (const repoId of ids) requests.push(await insertRequest(client, { repoId, wallet, actor, previousWallet: null }))
      return { count: requests.length, wallet, requestedByLogin: login, activeAt: requests[0].activeAt, requests, notify: [userId] }
    }, lockTimeoutMs)
  }

  // Any current admin can cancel a waiting address. Once its hold has passed it is the active binding and can only be
  // replaced (by a wallet signature, or another pasted address with its own hold).
  async function cancel({ githubRepoId, requestId, verifyAuthority }) {
    const repoId = repoIdOf(githubRepoId)
    assertAuthoritySource(verifyAuthority, repoId)
    const id = String(requestId ?? '')
    if (!REPO_ID.test(id)) fail('INVALID_REQUEST', 'Invalid payout address request.')
    const actor = await authorize(repoId, verifyAuthority, now)
    const { userId, login } = actor
    return inRepoLocks(pool, [repoId], async client => {
      await requireRecentAuthority(client, repoId, actor)
      await activateDueWithin(client, repoId)
      const { rows: [row] } = await client.query(`update payout_address_requests set status = 'cancelled', resolved_at = now(),
          resolved_by_github_user_id = $3, resolved_by_subject = $5, resolution_reason = $4
        where id = $1 and github_repo_id = $2 and status = 'pending' returning id::text as id, wallet`, [id, repoId, userId, `Cancelled by ${login}`, actor.subject])
      if (!row) {
        fail('NOT_PENDING', 'That pasted address is no longer waiting: it was cancelled, replaced, or its hold ended and it is now active. Refresh to see the current payout address.', 409)
      }
      const { rows: [active] } = await client.query('select wallet from repo_beneficiaries where github_repo_id = $1', [repoId])
      await client.query(`insert into payout_address_events(request_id, github_repo_id, event, github_user_id, github_login, actor_subject, wallet, previous_wallet)
        values ($1, $2, 'cancelled', $3, $4, $5, $6, $7)`, [row.id, repoId, userId, login, actor.subject, row.wallet, active?.wallet ?? null])
      return { repoId, requestId: row.id, wallet: row.wallet, cancelledBy: login }
    }, lockTimeoutMs)
  }

  return { request, requestBatch, cancel }
}
