import { ANALYTICS_RANGES } from '../../src/protocol-analytics.mjs'
import { readStockAnalytics } from '../../src/stock-analytics.mjs'
import { database } from './server.mjs'
import { ttlMemo } from './ttl-memo.mjs'

// /stats' per-stock totals (src/stock-analytics.mjs), read at most once per period per TOTALS_TTL_MS per process, as
// platformTotals does for the SOL totals. A failed read is never kept (the caller shows it as unavailable), so the next
// view retries. null without a database.
export const TOTALS_TTL_MS = 20_000
const memos = globalThis.__repoingStockPairTotals ??= new Map()

export function stockPairTotals(range = 'all', { db = database() } = {}) {
  if (!db) return Promise.resolve(null)
  const key = ANALYTICS_RANGES.includes(range) ? range : 'all'
  if (!memos.has(key)) memos.set(key, ttlMemo(() => readStockAnalytics(db, { range: key }), TOTALS_TTL_MS))
  return memos.get(key)()
}
