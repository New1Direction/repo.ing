import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { ACCOUNT_SIZE } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID, CpAmm } from '@meteora-ag/cp-amm-sdk'
import { receiverPaid } from './claim-amounts.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'

const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const EVENT = Buffer.from('e445a52e51cb9a1d','hex')
export async function verifyClaimReceipt(connection, intent) {
  const tx = await connection.getTransaction(intent.claimSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (!tx) return null
  if (tx.meta?.err) {
    return { status: 'aborted' }
  }
  const signed = Transaction.from(Buffer.from(intent.signedTransaction, 'base64'))
  if (!tx.meta || tx.transaction.signatures[0] !== intent.claimSignature ||
      !signed.compileMessage().serialize().equals(tx.transaction.message.serialize())) throw Error('Claim receipt differs from durable signed intent')
  const keys = tx.transaction.message.accountKeys
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  let dbcAmount = 0n, dammAmount = 0n, events = 0
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const program = keys[ix.programIdIndex]
      if (!program.equals(DBC) && !program.equals(CP_AMM_PROGRAM_ID)) continue
      const bytes = Buffer.from(bs58.decode(ix.data))
      if (!bytes.subarray(0,8).equals(EVENT)) continue
      const decoded = (program.equals(DBC) ? dbc.state.getProgram().coder : new CpAmm(connection)._program.coder).events.decode(bytes.subarray(8).toString('base64'))
      if (decoded?.name === 'evtClaimCreatorTradingFee') {
        if (BigInt(decoded.data.tokenBaseAmount.toString()) !== 0n) throw Error('Unexpected non-SOL creator payout')
        dbcAmount += BigInt(decoded.data.tokenQuoteAmount.toString()); events++
      } else if (decoded?.name === 'evtClaimPositionFee' || decoded?.name === 'EvtClaimPositionFee') {
        if (BigInt(decoded.data.feeAClaimed.toString()) !== 0n) throw Error('Unexpected non-SOL graduated payout')
        dammAmount += BigInt(decoded.data.feeBClaimed.toString()); events++
      }
    }
  }
  const expectedDamm = BigInt(intent.dammAmountBaseUnits ?? 0)
  const expected = BigInt(intent.amountBaseUnits)
  if (!events || dbcAmount !== expected - expectedDamm || dammAmount < expectedDamm ||
      (expectedDamm === 0n && dammAmount !== 0n)) throw Error('Finalized payout amount differs from authorized fee sources')
  const receiverIndex = keys.findIndex(key => key.toBase58() === intent.beneficiaryWallet)
  if (receiverIndex < 0) throw Error('Payout receiver missing from receipt')
  const receiverDelta = BigInt(tx.meta.postBalances[receiverIndex]) - BigInt(tx.meta.preBalances[receiverIndex])
  const rentRefund = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)) * BigInt(events)
  if (!receiverPaid(receiverDelta, dbcAmount + dammAmount, rentRefund)) throw Error('Bound beneficiary did not receive the proven payout')
  const amount = dbcAmount + dammAmount
  return { status: 'settled', signature: intent.claimSignature, amountBaseUnits: amount,
    dammAmountBaseUnits: dammAmount, receiverDeltaLamports: receiverDelta, rentRefundLamports: rentRefund, slot: BigInt(tx.slot) }
}

export async function settleClaim(client, connection, intent) {
  const receipt = await verifyClaimReceipt(connection, intent)
  if (receipt?.status === 'aborted') {
    await client.query("update repo_claims set status='aborted',resolved_at=now(),resolution_reason='Finalized transaction failed' where claim_signature=$1 and status='pending'", [intent.claimSignature])
  } else if (receipt?.status === 'settled') {
    await client.query("update repo_claims set status='settled',settled_at=now(),amount_base_units=$2,damm_amount_base_units=$3 where claim_signature=$1 and status='pending'",
      [intent.claimSignature, String(receipt.amountBaseUnits), String(receipt.dammAmountBaseUnits)])
  }
  return receipt
}

export function createClaimRecovery({ pool, connection }) {
  return { runOnce: async () => {
    const { rows } = await pool.query("select github_repo_id::text as repo from repo_claims where status='pending' and signed_transaction is not null")
    const results = []
    for (const row of rows) {
      const client = await pool.connect()
      try {
        const lock = await client.query('select pg_try_advisory_lock($1::bigint) as locked',[row.repo])
        if (!lock.rows[0].locked) continue
        try {
          const { rows: [intent] } = await client.query(`select claim_signature as "claimSignature", signed_transaction as "signedTransaction",
            amount_base_units::text as "amountBaseUnits", damm_amount_base_units::text as "dammAmountBaseUnits",
            beneficiary_wallet as "beneficiaryWallet", last_valid_block_height::text as expiry
            from repo_claims where github_repo_id=$1 and status='pending'`,[row.repo])
          if (!intent) continue
          let settled = await settleClaim(client, connection, intent)
          if (!settled) {
            const status = (await connection.getSignatureStatuses([intent.claimSignature], { searchTransactionHistory: true })).value[0]
            if (!status && BigInt(await connection.getBlockHeight('finalized')) > BigInt(intent.expiry)) {
              // Recheck history after observing expiry; an unavailable RPC throws rather than aborting.
              settled = await settleClaim(client, connection, intent)
              if (!settled && await provablyExpiredUnlanded(connection, intent.claimSignature, intent.expiry)) {
                await client.query("update repo_claims set status='aborted',resolved_at=now(),resolution_reason='Signed blockhash expired without chain evidence' where claim_signature=$1 and status='pending'",[intent.claimSignature])
                settled = { status: 'aborted' }
              }
            } else if (!status) {
              // Re-broadcast only the identical durable, previously authorized transaction.
              await connection.sendRawTransaction(Buffer.from(intent.signedTransaction, 'base64'), { skipPreflight: false })
            }
          }
          results.push({ githubRepoId: row.repo, status: settled?.status ?? 'pending', signature: intent.claimSignature })
        } finally { await client.query('select pg_advisory_unlock($1::bigint)',[row.repo]) }
      } catch (error) {
        console.error('claim recovery needs review', { repo: row.repo, error: error.message })
        results.push({ githubRepoId: row.repo, status: 'review' })
      }
      finally { client.release() }
    }
    return results
  } }
}
