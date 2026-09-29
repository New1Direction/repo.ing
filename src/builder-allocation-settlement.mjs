import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'

const AMOUNT = 10_000_000_000_000n
export async function settleAllocation(client, connection, intent) {
  const tx = await connection.getTransaction(intent.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (!tx) return null
  const signed = Transaction.from(Buffer.from(intent.signedTransaction, 'base64'))
  if (!tx.meta || tx.transaction.signatures[0] !== intent.signature ||
      !signed.compileMessage().serialize().equals(tx.transaction.message.serialize())) throw Error('Allocation receipt differs from durable intent')
  if (tx.meta.err) {
    await client.query("update builder_allocation_claims set status='aborted',resolution_reason='Finalized transaction failed' where signature=$1 and status='pending'", [intent.signature])
    return { status: 'aborted', signature: intent.signature }
  }
  const mint = new PublicKey(intent.mint), wallet = new PublicKey(intent.wallet)
  const destination = getAssociatedTokenAddressSync(mint, wallet)
  const keys = tx.transaction.message.accountKeys
  const recipientIndex = keys.findIndex(key => key.equals(destination))
  const transfers = tx.transaction.message.instructions.filter(ix => {
    const data = Buffer.from(bs58.decode(ix.data))
    return keys[ix.programIdIndex]?.equals(TOKEN_PROGRAM_ID) && data.length === 10 && data[0] === 12 &&
      data.readBigUInt64LE(1) === AMOUNT && data[9] === 6 && keys[ix.accounts[1]]?.equals(mint) && ix.accounts[2] === recipientIndex
  })
  if (String(intent.amount) !== String(AMOUNT) || transfers.length !== 1) throw Error('Allocation transfer does not match the fixed grant')
  const pre = tx.meta.preTokenBalances?.find(b => b.accountIndex === recipientIndex)
  const post = tx.meta.postTokenBalances?.find(b => b.accountIndex === recipientIndex)
  if (!post || post.owner !== intent.wallet || post.mint !== intent.mint || post.uiTokenAmount.decimals !== 6 ||
      post.programId !== TOKEN_PROGRAM_ID.toBase58() ||
      (pre && (pre.owner !== intent.wallet || pre.mint !== intent.mint)) ||
      BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0') !== AMOUNT) throw Error('Bound recipient did not receive exactly 1% of supply')
  await client.query("update builder_allocation_claims set status='settled',settled_at=now() where signature=$1 and status='pending'", [intent.signature])
  return { status: 'settled', signature: intent.signature, amount: String(AMOUNT), wallet: intent.wallet, mint: intent.mint }
}

export function createAllocationRecovery({ pool, connection }) {
  return { runOnce: async () => {
    const { rows } = await pool.query("select github_repo_id::text as repo from builder_allocation_claims where status='pending'")
    const results = []
    for (const row of rows) {
      const client = await pool.connect()
      try {
        if (!(await client.query('select pg_try_advisory_lock($1::bigint) as locked', [row.repo])).rows[0].locked) continue
        try {
          const { rows: [intent] } = await client.query(`select signature, signed_transaction as "signedTransaction", mint, wallet,
            amount::text, last_valid_block_height::text as expiry from builder_allocation_claims where github_repo_id=$1 and status='pending'`, [row.repo])
          if (!intent) continue
          let receipt = await settleAllocation(client, connection, intent)
          if (!receipt) {
            const status = (await connection.getSignatureStatuses([intent.signature], { searchTransactionHistory: true })).value[0]
            if (!status && BigInt(await connection.getBlockHeight('finalized')) > BigInt(intent.expiry)) {
              receipt = await settleAllocation(client, connection, intent)
              if (!receipt && await provablyExpiredUnlanded(connection, intent.signature, intent.expiry)) {
                await client.query("update builder_allocation_claims set status='aborted',resolution_reason='Expired without chain evidence' where signature=$1 and status='pending'", [intent.signature])
                receipt = { status: 'aborted' }
              }
            } else if (!status) await connection.sendRawTransaction(Buffer.from(intent.signedTransaction, 'base64'), { skipPreflight: false })
          }
          results.push({ githubRepoId: row.repo, status: receipt?.status ?? 'pending', signature: intent.signature })
        } finally { await client.query('select pg_advisory_unlock($1::bigint)', [row.repo]) }
      } catch (error) {
        console.error('allocation recovery needs review', { repo: row.repo, error: error.message })
        results.push({ githubRepoId: row.repo, status: 'review' })
      }
      finally { client.release() }
    }
    return results
  } }
}
