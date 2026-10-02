import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { ComputeBudgetProgram, PublicKey, SystemInstruction, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'
import { broadcastUntilSettled, isDustPayout, maxPayoutNetworkFee, readTradeComputeBudget, signedWithPriorityFee } from './trade-landing.mjs'
import { CAP_WINDOW_MS, VerificationBonusError, capAllows, formatBonusSol, nextBonusStatus, nextPayoutStatus, payerShortfall,
  requireReviewedTerms, verificationBonusPayoutConfig, withBonusLock } from './verification-bonus.mjs'
import { bonusRepoId, currentSelfLaunchBlock } from './verification-bonus-review.mjs'

// Payouts of approved bonuses: a plain SOL transfer from the protected partner signer (the key that already pays
// discovery-claim network fees) to the launcher wallet, plus a memo naming the payout's idempotency key. Web only: the
// worker gets no key and only settles or rebroadcasts already signed bytes. Ships dark (VERIFICATION_BONUS_PAYOUTS_ENABLED).
//
// Money discipline, as for discovery claims: integer lamports; the bonus row (copied from the market's stamp) is the
// amount; the fully signed transaction is committed as 'pending' before its first broadcast; settlement needs the
// finalized transaction matching the saved message with the launcher gaining exactly the bonus and the payer spending
// exactly the bonus plus the network fee; an attempt is aborted only on a finalized failure or provable expiry with no
// transaction in history; a partial unique index allows one live or settled payout per bonus.

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
// One signature (the partner fee payer) plus the bounded priority fee: at most 0.000805 SOL.
export const BONUS_MAX_NETWORK_FEE_LAMPORTS = maxPayoutNetworkFee(1)
// The first broadcast rebroadcasts briefly inside the request; recovery keeps rebroadcasting the same bytes afterwards.
const SUBMIT_BROADCAST_MS = 12_000
const fail = (message, status) => { throw new VerificationBonusError(message, status) }
const local = connection => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(String(connection.rpcEndpoint ?? ''))

export const payoutIdempotencyKey = (repoId, attempt) => `verification-bonus:v1:${repoId}:${attempt}`
export const bonusPayoutMemo = ({ idempotencyKey, id, amount }) => `repo.ing ${idempotencyKey} payout ${id} lamports ${amount}`

// Exactly what a bonus payout may contain: the payer as the only signer and fee payer, the landing compute budget,
// one system transfer payer → launcher of exactly the amount, and one memo with the stored text. Nothing else.
export function checkBonusPayoutShape(signed, payout) {
  const review = () => fail('Stored bonus payout does not match its intent; settlement review required')
  const payer = new PublicKey(payout.payer), wallet = new PublicKey(payout.wallet), amount = BigInt(payout.amount)
  if (!signed.feePayer?.equals(payer) || signed.signatures.length !== 1 || !signed.signatures[0].publicKey.equals(payer)) review()
  try { readTradeComputeBudget(signed.instructions) } catch { review() }
  let transfers = 0, memos = 0
  for (const ix of signed.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) continue
    if (ix.programId.equals(SystemProgram.programId)) {
      let transfer = null
      try { transfer = SystemInstruction.decodeInstructionType(ix) === 'Transfer' ? SystemInstruction.decodeTransfer(ix) : null } catch { transfer = null }
      if (!transfer || !transfer.fromPubkey.equals(payer) || !transfer.toPubkey.equals(wallet) || BigInt(transfer.lamports) !== amount) review()
      transfers++
    } else if (ix.programId.equals(MEMO) && ix.keys.length === 0 && Buffer.from(ix.data).toString('utf8') === payout.memo) memos++
    else review()
  }
  if (transfers !== 1 || memos !== 1) review()
  return { payer, wallet, amount }
}

// Lamports already promised by payouts from this payer that have not settled or aborted yet.
export async function readPendingLamports(db, payer) {
  const { rows: [row] } = await db.query(`select coalesce(sum(amount), 0)::text as pending from verification_bonus_payouts
    where status = 'pending' and payer = $1`, [payer])
  return BigInt(row.pending)
}

// Platform revenue the ledger says the payer wallet still holds for other uses: settled claims it received that are
// not allocated yet, and the liquidity share allocated from those claims that is not yet deployed. Bonuses are a
// treasury expense and never spend these (read-only; the 60/20/20 ledger itself is unchanged). The buyback share is
// moved to custody by the platform sweep, so it is not counted here; see docs/VERIFICATION_BONUS.md.
export async function readProtectedRevenue(db, payer) {
  const { rows: [row] } = await db.query(`select
      coalesce((select sum(c.amount) from platform_fee_claims c where c.status = 'settled' and c.wallet = $1
        and not exists (select 1 from platform_revenue_allocations a where a.claim_signature = c.signature)), 0)::text as unallocated,
      coalesce((select sum(a.liquidity_amount) from platform_revenue_allocations a
        join platform_fee_claims c on c.signature = a.claim_signature and c.status = 'settled' where c.wallet = $1), 0)::text as "liquidityAllocated",
      coalesce((select sum(case when status = 'settled' then settled_debit when status <> 'aborted' then source_amount else 0 end)
        from liquidity_intents where source_wallet = $1), 0)::text as "liquidityCommitted"`, [payer])
  const unallocated = BigInt(row.unallocated), liquidityLeft = BigInt(row.liquidityAllocated) - BigInt(row.liquidityCommitted)
  const liquidity = liquidityLeft > 0n ? liquidityLeft : 0n
  return { unallocated, liquidity, total: unallocated + liquidity }
}

export async function readCommittedLamports(db, at = Date.now()) {
  const { rows: [row] } = await db.query(`select (coalesce(sum(amount) filter (where status = 'pending'), 0)
      + coalesce(sum(amount) filter (where status = 'settled' and settled_at >= $1), 0))::text as committed
    from verification_bonus_payouts`, [new Date(at - CAP_WINDOW_MS)])
  return BigInt(row.committed)
}

const outcome = (payout, status, extra = {}) => ({ repoId: String(payout.github_repo_id), id: payout.id, attempt: Number(payout.attempt),
  status, signature: payout.signature, amount: String(payout.amount), ...extra })

export function createVerificationBonusPayouts({ pool, connection, partner = null, env = process.env, now = Date.now,
  submitBroadcastMs = SUBMIT_BROADCAST_MS }) {
  async function abort(db, payout, reason) {
    nextPayoutStatus(payout.status, 'aborted')
    await db.query(`update verification_bonus_payouts set status = 'aborted', resolved_at = $2, resolution_reason = $3
      where id = $1 and status = 'pending'`, [payout.id, new Date(now()), reason])
    return outcome(payout, 'aborted', { reason })
  }

  async function settle(db, payout) {
    const signed = Transaction.from(Buffer.from(payout.signed_transaction, 'base64'))
    if (!signed.verifySignatures() || bs58.encode(signed.signature) !== payout.signature) fail('Stored bonus payout signature needs settlement review')
    const { payer, wallet, amount } = checkBonusPayoutShape(signed, payout)
    const chainTx = await connection.getTransaction(payout.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (chainTx?.meta) {
      if (chainTx.transaction.signatures[0] !== payout.signature ||
          !chainTx.transaction.message.serialize().equals(signed.serializeMessage())) fail('Finalized bonus payout does not match the saved intent')
      if (chainTx.meta.err) return abort(db, payout, 'Transaction finalized with an error; no bonus was paid')
      const keys = chainTx.transaction.message.accountKeys
      const delta = address => {
        const index = keys.findIndex(key => key.equals(address))
        if (index < 0) fail('Bonus payout receipt needs settlement review')
        return BigInt(chainTx.meta.postBalances[index]) - BigInt(chainTx.meta.preBalances[index])
      }
      const fee = BigInt(chainTx.meta.fee)
      if (delta(wallet) !== amount || delta(payer) !== -(amount + fee)) fail('Bonus payout receipt needs settlement review')
      nextPayoutStatus(payout.status, 'settled')
      // One settlement: the payout and its bonus change together, each only from the state it must be in.
      const settledAt = new Date(now())
      await db.query('begin')
      try {
        const settled = await db.query(`update verification_bonus_payouts set status = 'settled', settled_at = $2, network_fee = $3,
          slot = $4 where id = $1 and status = 'pending'`, [payout.id, settledAt, fee.toString(), String(chainTx.slot)])
        const paid = await db.query(`update verification_bonuses set status = 'paid', paid_at = $2
          where github_repo_id = $1 and status = 'approved'`, [String(payout.github_repo_id), settledAt])
        if (settled.rowCount !== 1 || paid.rowCount !== 1) throw new Error('Bonus settlement state changed; settlement review required')
        await db.query('commit')
      } catch (error) { await db.query('rollback'); throw error }
      return outcome(payout, 'settled', { networkFee: fee.toString(), slot: String(chainTx.slot) })
    }
    const status = (await connection.getSignatureStatuses([payout.signature], { searchTransactionHistory: true })).value[0]
    // A processed/confirmed status stays ambiguous until finalized evidence exists, even after blockhash expiry.
    if (!status && await provablyExpiredUnlanded(connection, payout.signature, payout.last_valid_block_height)) {
      return abort(db, payout, 'Blockhash expired with no transaction in finalized history')
    }
    return outcome(payout, 'pending')
  }

  async function readPayable(db, repoId) {
    const { rows: [bonus] } = await db.query(`select b.github_repo_id::text as "repoId", b.status, b.amount::text as amount,
        b.launcher_wallet as "launcherWallet", b.verifier_github_user_id::text as "verifierGithubUserId",
        m.verification_bonus_lamports::text as "marketAmount", m.launcher_wallet as "marketLauncher"
      from verification_bonuses b join markets m on m.github_repo_id = b.github_repo_id where b.github_repo_id = $1`, [repoId])
    if (!bonus) fail('Verification bonus not found', 404)
    return bonus
  }

  // Builds, prices, funds-checks, simulates and signs the payout for one attempt. Nothing is stored or sent here.
  async function buildSignedPayout({ repoId, attempt, wallet, amount, config, db }) {
    const id = randomUUID(), idempotencyKey = payoutIdempotencyKey(repoId, attempt)
    const memo = bonusPayoutMemo({ idempotencyKey, id, amount })
    const transfer = new Transaction().add(SystemProgram.transfer({ fromPubkey: partner.publicKey, toPubkey: wallet, lamports: amount }),
      new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(memo, 'utf8') }))
    const latest = await connection.getLatestBlockhash('confirmed')
    const { transaction } = await signedWithPriorityFee(connection, transfer, { feePayer: partner.publicKey,
      blockhash: latest.blockhash, signers: [partner] })
    const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value
    if (fee === null || fee === undefined || BigInt(fee) > BONUS_MAX_NETWORK_FEE_LAMPORTS || isDustPayout(amount, fee)) {
      fail('Solana network fees are unusually high right now. The bonus stays approved; try again shortly.')
    }
    const payer = partner.publicKey.toBase58()
    const [balance, pending, protectedRevenue] = await Promise.all([connection.getBalance(partner.publicKey, 'confirmed'),
      readPendingLamports(db, payer), readProtectedRevenue(db, payer)])
    const shortfall = payerShortfall({ balance: BigInt(balance), pending, amount, fee: BigInt(fee), reserve: config.reserve,
      protectedLamports: protectedRevenue.total })
    if (shortfall > 0n) {
      fail(`The payout signer needs ${formatBonusSol(shortfall)} SOL more: it holds ${formatBonusSol(balance)} SOL, ` +
        `${formatBonusSol(pending)} SOL is in flight for other bonuses, ${formatBonusSol(protectedRevenue.total)} SOL is unallocated or ` +
        `liquidity revenue that bonuses never spend, and it keeps ${formatBonusSol(config.reserve)} SOL for operations. The bonus stays approved.`)
    }
    const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(transaction.serialize()),
      { sigVerify: true, commitment: 'confirmed' })
    if (simulation.value.err) fail('The payout could not be simulated, so nothing was sent. The bonus stays approved.')
    const raw = transaction.serialize(), signature = bs58.encode(transaction.signature)
    const intent = { id, github_repo_id: repoId, attempt, idempotency_key: idempotencyKey, wallet: wallet.toBase58(), payer,
      amount: amount.toString(), memo, status: 'pending', signature, signed_transaction: raw.toString('base64'),
      last_valid_block_height: String(latest.lastValidBlockHeight) }
    checkBonusPayoutShape(Transaction.from(raw), intent)
    return { raw, signature, intent, latest }
  }

  async function pay({ repoId, operator, expected }) {
    const id = bonusRepoId(repoId)
    const config = verificationBonusPayoutConfig(env)
    if (config.error) fail(`${config.error}. Bonus payouts stay stopped until it is fixed.`)
    if (!config.enabled) fail('Verification bonus payouts are off (VERIFICATION_BONUS_PAYOUTS_ENABLED). Approved bonuses wait as approved.')
    if (!partner) fail('The bonus payout signer is not configured on this server')
    if (!/^[1-9]\d*$/.test(String(operator?.githubUserId ?? ''))) fail('Operator identity is required', 401)
    return withBonusLock(pool, async db => {
      const bonus = await readPayable(db, id)
      requireReviewedTerms(bonus, expected)
      const { rows: [active] } = await db.query(`select * from verification_bonus_payouts where github_repo_id = $1
        and status in ('pending', 'settled') limit 1`, [id])
      // Idempotent: a settled payout is returned, a pending one is only re-checked; neither is ever re-signed.
      if (active?.status === 'settled') return outcome(active, 'settled')
      if (active) return settle(db, active)
      nextBonusStatus(bonus.status, 'paid')
      if (bonus.marketAmount !== bonus.amount || bonus.marketLauncher !== bonus.launcherWallet) {
        fail('This bonus no longer matches its market’s stored policy; settlement review required')
      }
      const blocked = await currentSelfLaunchBlock(db, bonus)
      if (blocked) fail(`${blocked}. Reject this bonus instead of paying it.`)
      const amount = BigInt(bonus.amount)
      const committed = await readCommittedLamports(db, now())
      if (!capAllows({ committed, amount, cap: config.cap })) {
        fail(`Paying ${formatBonusSol(amount)} SOL would pass the rolling 30-day cap of ${formatBonusSol(config.cap)} SOL ` +
          `(${formatBonusSol(committed)} SOL settled or in flight). The bonus stays approved.`)
      }
      const genesis = await connection.getGenesisHash()
      if (!local(connection) && genesis !== MAINNET) fail('Verification bonus payouts require Solana mainnet')
      const wallet = new PublicKey(bonus.launcherWallet)
      if (wallet.equals(partner.publicKey)) fail('The payout signer cannot receive a verification bonus')
      const { rows: [{ attempt }] } = await db.query(`select coalesce(max(attempt), 0) + 1 as attempt
        from verification_bonus_payouts where github_repo_id = $1`, [id])
      const { raw, signature, intent, latest } = await buildSignedPayout({ repoId: id, attempt, wallet, amount, config, db })
      // Durable intent: these exact bytes are committed before the first broadcast.
      await db.query(`insert into verification_bonus_payouts (id, github_repo_id, attempt, idempotency_key, wallet, payer, amount, memo,
          status, signature, signed_transaction, last_valid_block_height, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12)`,
      [intent.id, id, attempt, intent.idempotency_key, intent.wallet, intent.payer, intent.amount, intent.memo, signature,
        intent.signed_transaction, intent.last_valid_block_height, `${operator.githubUserId}:${operator.githubLogin ?? ''}`])
      try {
        await broadcastUntilSettled(connection, raw, { signature, lastValidBlockHeight: latest.lastValidBlockHeight, maxMs: submitBroadcastMs })
      } catch { /* The intent stays pending; recovery rebroadcasts these exact bytes and never signs a replacement. */ }
      return outcome(intent, 'pending')
    })
  }

  // Settles the bonus's pending payout or rebroadcasts its exact signed bytes. Needs no key.
  async function recover(repoId) {
    const id = bonusRepoId(repoId)
    return withBonusLock(pool, async db => {
      const { rows: [payout] } = await db.query(`select * from verification_bonus_payouts where github_repo_id = $1
        and status = 'pending' limit 1`, [id])
      if (!payout) return { repoId: id, status: 'idle' }
      const current = await settle(db, payout)
      if (current.status === 'pending') {
        try {
          await connection.sendRawTransaction(Buffer.from(payout.signed_transaction, 'base64'),
            { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
        } catch { /* Stays pending until finality or proven expiry. */ }
      }
      return current
    })
  }

  async function runOnce() {
    const { rows } = await pool.query(`select github_repo_id::text as "repoId" from verification_bonus_payouts
      where status = 'pending' order by created_at`)
    const results = []
    for (const { repoId } of rows) {
      try { results.push(await recover(repoId)) }
      catch (error) {
        // Busy: a web request holds the lock (it is sending or settling this payout); the next pass retries.
        if (error?.busy) { results.push({ repoId, status: 'busy' }); continue }
        console.error('verification bonus payout needs review', { repo: repoId, error: error.message })
        results.push({ repoId, status: 'review' })
      }
    }
    return results
  }
  return { pay, recover, runOnce, settle }
}
