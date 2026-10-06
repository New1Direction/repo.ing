import bs58 from 'bs58'
import { broadcastUntilSettled, isDustPayout, maxPayoutNetworkFee, signedWithPriorityFee } from './trade-landing.mjs'
import { PublicKey, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createGraduatedFees, recordPlatformFees } from './graduated-fees.mjs'
import { recoverDbcPlatformClaim } from './platform-dbc-fees.mjs'

export async function platformFeeRecord(pool, repoId) {
  const id = String(repoId)
  const { rows: [market] } = await pool.query(`select github_repo_id::text as "githubRepoId", mint, pool,
    creator_wallet as "creatorWallet" from markets
    where github_repo_id=$1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'
    and early_access_end is null and bundle_id is null`, [id])
  if (!market) return null
  const { rows: [state] } = await pool.query(`select coalesce((select sum(amount_base_units) from platform_fee_events
    where github_repo_id=$1),0)::text as earned`, [id])
  const { rows: claims } = await pool.query(`select status, signature, wallet, amount::text from platform_fee_claims
    where github_repo_id=$1 and phase='DAMM' order by id desc`, [id])
  const paid = claims.filter(c => c.status === 'settled').reduce((total, c) => total + BigInt(c.amount), 0n)
  return { ...market, earned: BigInt(state.earned), paid, claims }
}

export function createPlatformFees({ pool, connection, config, partner }) {
  const graduatedFees = createGraduatedFees({ connection, config, db: pool })

  async function status(repoId) {
    const record = await platformFeeRecord(pool, repoId)
    if (!record) return { enrolled: false }
    const snapshot = await graduatedFees.read(record)
    if (!snapshot?.partner) return { enrolled: false }
    return { enrolled: true, pool: snapshot.partner.pool.toBase58(), earned: record.earned.toString(),
      paid: record.paid.toString(), available: (record.earned - record.paid).toString(),
      onchainAvailable: snapshot.partner.available.toString(), state: 'available', latest: record.claims[0] ?? null }
  }

  // `retryRead` wraps each chain read made before the claim is signed (the sweep retries transient RPC errors there).
  // Signing, the fee check, simulation, the durable intent, broadcast and settlement never use it.
  async function claim({ review, retryRead = read => read() }) {
    if (!partner || !review || review.purpose !== 'platform-fee-review' || review.expiresAt <= Date.now()) throw Error('Platform fee review expired')
    const repoId = String(review.repoId)
    if (!/^[1-9]\d*$/.test(repoId)) throw Error('Invalid repository')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId])
      try {
        const record = await platformFeeRecord(client, repoId)
        if (!record) throw Error('Market is not indexed for platform fees')
        const outstanding = record.earned - record.paid
        const pending = (await client.query("select 1 from platform_fee_claims where github_repo_id=$1 and status='pending'", [repoId])).rows[0]
        if (pending) throw Error('A platform fee claim is already in flight')
        if (outstanding <= 0n) throw Error('No platform fees remain to claim')
        if (BigInt(review.amount) !== outstanding) throw Error('Reviewed amount differs from indexed fees; refresh and review again')
        const snapshot = await retryRead(() => graduatedFees.read(record))
        if (!snapshot?.partner) throw Error('Graduated partner position is unavailable')
        if (snapshot.partner.available !== outstanding) throw Error('Partner fees differ from indexed accrual; indexing must catch up')
        const receiver = new PublicKey(review.receiver)
        if (!receiver.equals(partner.publicKey)) throw Error('Platform fees pay the protected partner wallet')
        const p = snapshot.partner.poolState
        const claimTx = new Transaction()
        claimTx.add(await retryRead(() => snapshot.amm.claimPositionFee2({ owner: partner.publicKey, feePayer: partner.publicKey,
          receiver, pool: snapshot.partner.pool, position: snapshot.partner.position,
          positionNftAccount: snapshot.partner.nftAccount,
          tokenAMint: p.tokenAMint, tokenBMint: p.tokenBMint,
          tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault,
          tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID })))
        const latest = await retryRead(() => connection.getLatestBlockhash('confirmed'))
        // The partner pays the network fee (base + priority) out of the claim it receives.
        const { transaction: tx } = await signedWithPriorityFee(connection, claimTx, { feePayer: partner.publicKey,
          blockhash: latest.blockhash, signers: [partner] })
        const fee = (await connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value
        if (fee == null || BigInt(fee) > maxPayoutNetworkFee(1)) throw Error('Platform fee network cost is unavailable or above its ceiling')
        if (isDustPayout(outstanding, fee)) return { status: 'skipped-dust', broadcast: false, amount: outstanding.toString(), networkFee: String(fee) }
        const simulation = await connection.simulateTransaction(tx)
        if (simulation.value.err) throw Error('Platform fee preflight failed')
        if (review.expiresAt <= Date.now()) throw Error('Platform fee review expired')
        const signature = bs58.encode(tx.signature), signedTransaction = tx.serialize().toString('base64')
        const intent = { signature, signedTransaction, wallet: receiver.toBase58(), amount: outstanding.toString(),
          pool: snapshot.partner.pool.toBase58() }
        await client.query(`insert into platform_fee_claims
          (github_repo_id, pool, wallet, amount, status, signature, signed_transaction, last_valid_block_height)
          values ($1,$2,$3,$4,'pending',$5,$6,$7)`, [repoId, intent.pool, intent.wallet, intent.amount,
          signature, signedTransaction, latest.lastValidBlockHeight])
        await broadcastUntilSettled(connection, tx.serialize(), { signature, lastValidBlockHeight: latest.lastValidBlockHeight })
        await connection.confirmTransaction({ signature, ...latest }, 'finalized')
        const receipt = await settlePlatformClaim(client, connection, intent)
        if (!receipt) throw Error('Platform fee submitted; final receipt is being checked')
        const settled = await graduatedFees.read(record)
        if (settled?.partner && settled.partner.claimed - snapshot.partner.claimed !== BigInt(receipt.amount))
          throw Error('Partner claim checkpoint differs from the settled amount')
        return receipt
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId]) }
    } finally { client.release() }
  }
  return { status, claim }
}
export async function settlePlatformClaim(db, connection, intent) {
  const receipt = await connection.getTransaction(intent.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (!receipt?.meta || receipt.meta.err) return null
  const receiver = new PublicKey(intent.wallet)
  const index = receipt.transaction.message.accountKeys.findIndex(key => key.equals(receiver))
  if (index < 0) throw Error('Receiver is absent from the settled platform fee transaction')
  const delta = BigInt(receipt.meta.postBalances[index] ?? 0) - BigInt(receipt.meta.preBalances[index] ?? 0)
  // claimPositionFee takes everything accrued at execution, so an active pool settles a little MORE than was
  // reviewed. The receiver is the fee payer (it pays the network fee; wrapped-SOL rent nets to zero), so the
  // claimed amount is delta + fee. Record what actually settled, within sane bounds; the caller checks it
  // against the position claim checkpoint.
  const reviewed = BigInt(intent.amount), claimed = delta + BigInt(receipt.meta.fee)
  if (claimed + 5_000_000n < reviewed || claimed > reviewed * 3n + 1_000_000_000n)
    throw Error('Settled platform fee delta differs from the reviewed amount')
  const settledAmount = claimed > reviewed ? claimed : reviewed
  const { rows: [updated] } = await db.query(`update platform_fee_claims set status='settled', settled_at=now(), amount=$2
    where signature=$1 and status='pending' returning status, signature, wallet, amount::text`, [intent.signature, settledAmount.toString()])
  return updated ?? null
}

export function createPlatformFeeRecovery({ pool, connection }) {
  async function runOnce() {
    const { rows: pending } = await pool.query(`select github_repo_id::text as "repoId", signature,
      signed_transaction as "signedTransaction", wallet, amount::text, pool, phase, evidence,
      last_valid_block_height::text as "lastValidBlockHeight" from platform_fee_claims where status='pending'`)
    const results = []
    // No pending claim, no chain read: this runs every worker cycle.
    if (!pending.length) return results
    const height = BigInt(await connection.getBlockHeight('finalized'))
    for (const intent of pending) {
      if (intent.phase === 'DBC') {
        try { results.push(await recoverDbcPlatformClaim(pool, connection, intent)) }
        catch { results.push({ repoId: intent.repoId, signature: intent.signature, status: 'review' }) }
        continue
      }
      const receipt = await connection.getTransaction(intent.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      if (receipt?.meta && !receipt.meta.err) {
        try {
          const settled = await settlePlatformClaim(pool, connection, intent)
          results.push({ repoId: intent.repoId, signature: intent.signature, status: settled ? 'settled' : 'review' })
        } catch (error) {
          results.push({ repoId: intent.repoId, signature: intent.signature, status: 'error', reason: error.message })
        }
      } else if (receipt?.meta) {
        await pool.query(`update platform_fee_claims set status='aborted', resolved_at=now(),
          resolution_reason='Finalized transaction failed' where signature=$1 and status='pending'`, [intent.signature])
        results.push({ repoId: intent.repoId, signature: intent.signature, status: 'aborted', reason: 'Finalized transaction failed' })
      } else if (height > BigInt(intent.lastValidBlockHeight) + 31n) {
        await pool.query(`update platform_fee_claims set status='aborted', resolved_at=now(),
          resolution_reason='Transaction expired without finality' where signature=$1 and status='pending'`, [intent.signature])
        results.push({ repoId: intent.repoId, signature: intent.signature, status: 'aborted', reason: 'Transaction expired without finality' })
      } else {
        results.push({ repoId: intent.repoId, signature: intent.signature, status: 'review' })
      }
    }
    return results
  }
  return { runOnce }
}
