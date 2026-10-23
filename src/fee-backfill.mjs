import { PublicKey } from '@solana/web3.js'

// Read-only discovery, independent of the live cursor. A complete launch boundary
// is required even when replaying a historical snapshot; newer trades are excluded.
export async function discoverFeeBackfill({ connection, market, throughSlot, maxPages = 20 }) {
  if (!market.launchSignature || !Number.isSafeInteger(throughSlot) || throughSlot < 0 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1) throw Error('Bounded finalized history required')
  const signatures = new Map()
  const seen = new Set()
  let before
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await connection.getSignaturesForAddress(new PublicKey(market.pool),
      { limit: 1000, ...(before ? { before } : {}) }, 'finalized')
    if (!page.length) break
    for (const item of page) {
      if (!Number.isSafeInteger(item.slot) || item.slot < 0 || item.confirmationStatus !== 'finalized') {
        throw Error('History contains non-finalized or invalid slot evidence')
      }
      if (seen.has(item.signature)) throw Error('History repeated a signature')
      seen.add(item.signature)
      if (!item.err && item.slot <= throughSlot) signatures.set(item.signature, item)
      if (item.signature === market.launchSignature) {
        if (item.err || item.slot > throughSlot) throw Error('Launch is outside successful snapshot history')
        return { githubRepoId: String(market.githubRepoId), pool: market.pool, throughSlot,
          complete: true, pages: pageIndex + 1, signatures: [...signatures.values()].reverse() }
      }
    }
    before = page.at(-1).signature
  }
  throw Error('Finalized pool history does not reach launch within reviewed bound')
}

// The caller explicitly supplies the existing signer-free ledger writer. Never
// computes balancing amounts, updates cursors, signs, or sends a transaction.
// Partial progress is safe: recordTradeFees owns evidence checks/locking/dedup.
export async function replayFeeBackfill({ history, accrual }) {
  if (history?.complete !== true || !Array.isArray(history.signatures) || !history.signatures.length ||
      !Number.isSafeInteger(history.throughSlot)) throw Error('Complete bounded history required')
  for (const item of history.signatures) {
    if (item.err || item.confirmationStatus !== 'finalized' || !Number.isSafeInteger(item.slot) ||
        item.slot < 0 || item.slot > history.throughSlot || typeof item.signature !== 'string' || !item.signature) {
      throw Error('Replay contains invalid finalized history')
    }
  }
  const results = []
  for (const signature of new Set(history.signatures.map(item => item.signature))) {
    results.push(await accrual.recordTradeFees({ githubRepoId: history.githubRepoId,
      signatures: [signature], allowNonSwap: true }))
  }
  return { results, creditedBaseUnits: results.reduce((sum, result) => sum + result.creditedBaseUnits, 0n),
    eventKeys: [...new Set(results.flatMap(result => result.eventKeys))] }
}
