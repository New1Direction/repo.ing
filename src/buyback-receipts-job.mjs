import { PublicKey } from '@solana/web3.js'
import { BUYBACK_SOURCES } from '../app/lib/buyback-receipts.mjs'
import { BUYBACK_SINCE, detectBuyback } from './buyback-detection.mjs'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'

const PAGE_SIZE = 1000
const MAX_PAGES = 5
// Cursor advances after each fully processed chunk, so a flaky RPC still makes progress.
const CHUNK_SIZE = 25

// Code may deploy before migration 0025. Only a missing table (42P01) skips the job; every other
// database error still fails the run.
let warnedMissing = false
class TableMissing extends Error {}
async function receiptQuery(db, text, params) {
  try { return await db.query(text, params) } catch (error) {
    if (error?.code !== '42P01') throw error
    if (!warnedMissing) { warnedMissing = true; console.log('buyback receipts table missing; skipping') }
    throw new TableMissing()
  }
}

const sol = lamports => `${lamports / 1_000_000_000n}.${String(lamports % 1_000_000_000n).padStart(9, '0')}`.replace(/\.?0+$/, '')

export function createBuybackReceiptsJob({ pool, connection, loadTransaction = loadFinalizedTransaction,
  wallets = BUYBACK_SOURCES, since = BUYBACK_SINCE, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, chunkSize = CHUNK_SIZE }) {
  // Newest-first signatures above the cursor (or, on the first run, back to `since`). Fails closed
  // instead of skipping history when the backlog exceeds the page budget.
  async function pending(wallet, cursor) {
    const found = []
    let before
    for (let page = 0; page < maxPages; page++) {
      const items = await connection.getSignaturesForAddress(new PublicKey(wallet),
        { limit: pageSize, ...(before ? { before } : {}), ...(cursor ? { until: cursor } : {}) }, 'finalized')
      for (const item of items) {
        if (item.signature === cursor) return found
        if (!cursor && item.blockTime != null && item.blockTime * 1000 < Date.parse(since)) return found
        found.push(item)
      }
      if (items.length < pageSize) return found
      before = items.at(-1).signature
    }
    throw Error('BUYBACK_HISTORY_BACKLOG')
  }

  async function scan(source, wallet) {
    const { rows: [cursor] } = await receiptQuery(pool, 'select last_signature from buyback_receipt_cursors where wallet=$1', [wallet])
    const items = (await pending(wallet, cursor?.last_signature)).reverse()
    const receipts = []
    for (let start = 0; start < items.length; start += chunkSize) {
      const chunk = items.slice(start, start + chunkSize)
      for (const item of chunk) {
        if (item.err) continue
        const tx = await loadTransaction(connection, item.signature)
        if (!tx) throw Error('BUYBACK_TRANSACTION_UNAVAILABLE')
        const receipt = detectBuyback(tx, { wallet, source, since })
        if (!receipt) continue
        const { rows } = await receiptQuery(pool, `insert into buyback_receipts
          (signature, source, wallet, mint, spent_lamports, token_base_units, block_time, slot) values ($1,$2,$3,$4,$5,$6,$7,$8)
          on conflict (signature) do nothing returning signature`, [receipt.signature, receipt.source, receipt.wallet, receipt.mint,
          receipt.spentLamports, receipt.tokenBaseUnits, receipt.at, receipt.slot])
        if (!rows.length) continue
        receipts.push(receipt.signature)
        console.log(JSON.stringify({ buybackReceipt: { signature: receipt.signature, source, sol: sol(BigInt(receipt.spentLamports)) } }))
      }
      const newest = chunk.at(-1)
      // Monotonic: a slower concurrent run never moves the cursor backwards.
      await receiptQuery(pool, `insert into buyback_receipt_cursors (wallet, last_signature, last_slot) values ($1,$2,$3)
        on conflict (wallet) do update set last_signature=excluded.last_signature, last_slot=excluded.last_slot, updated_at=now()
        where buyback_receipt_cursors.last_slot <= excluded.last_slot`, [wallet, newest.signature, String(newest.slot)])
    }
    return { source, scanned: items.length, receipts }
  }

  async function runOnce() {
    const results = []
    try { for (const [source, wallet] of Array.isArray(wallets) ? wallets : Object.entries(wallets)) results.push(await scan(source, wallet)) }
    catch (error) { if (error instanceof TableMissing) return { skipped: 'TABLE_MISSING' }; throw error }
    return results
  }
  return { runOnce }
}
