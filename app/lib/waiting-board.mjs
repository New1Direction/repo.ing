import { database, listMarkets, recentBuilderPayouts } from './server.mjs'
import { ttlMemo } from './ttl-memo.mjs'
import { recentlyClaimed, selectWaiting, waitingTotal, WAITING_LIMIT } from './waiting.mjs'
import { promotionExclusions } from './promotion-exclusions.mjs'

// /waiting: the shared market list (already memoized) plus one small read of maintainers who asked not
// to be contacted. No per-row RPC. Fails closed: without the opt-out list nothing is shown.
const WAITING_TTL_MS = 30_000
const EMPTY = { waiting: [], count: 0, total: '0', claimed: [] }
export const waitingBoard = ttlMemo(loadWaitingBoard, WAITING_TTL_MS, { keep: result => !result.unavailable })

// Dismissed invites plus the do-not-promote list (PROMOTION_EXCLUDED_REPO_IDS and maintainers' opt-outs).
async function optedOutRepos(pool) {
  const [{ rows }, excluded] = await Promise.all([
    pool.query('select github_repo_id::text as "repoId" from maintainer_invites where dismissed_at is not null'), promotionExclusions(pool)])
  return new Set([...rows.map(row => row.repoId), ...excluded])
}

async function loadWaitingBoard() {
  const pool = database()
  if (!pool) return { ...EMPTY, unavailable: 'Database is not configured.' }
  try {
    const [{ markets, unavailable }, optedOut, payouts] = await Promise.all([listMarkets(), optedOutRepos(pool), recentBuilderPayouts()])
    if (unavailable) return { ...EMPTY, unavailable }
    const all = selectWaiting(markets, { optedOut })
    return { waiting: all.slice(0, WAITING_LIMIT), count: all.length, total: waitingTotal(all),
      claimed: payouts.unavailable ? [] : recentlyClaimed(payouts.payouts) }
  } catch { return { ...EMPTY, unavailable: 'Waiting builder fees are temporarily unavailable.' } }
}
