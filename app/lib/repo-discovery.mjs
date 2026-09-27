import { trendOperatorView } from '../../src/trend-intake.mjs'
import { publicTrendCandidates } from '../../src/public-trends.mjs'
import { TREND_FRESH_MS } from '../../src/trend-rules.mjs'

const snapshots = new WeakMap()

// Find repos needs only public trends, not the earnings/leaderboard queries.
export async function repositoryCandidates(pool) {
  if (!pool) throw Error('Repository discovery is unavailable')
  let entry = snapshots.get(pool)
  if (!entry || entry.expires <= Date.now()) {
    entry = { expires: Date.now() + 15000, promise: trendOperatorView(pool).then(view => publicTrendCandidates(view.candidates)) }
    snapshots.set(pool, entry)
    entry.promise.catch(() => { if (snapshots.get(pool) === entry) snapshots.delete(pool) })
  }
  return (await entry.promise).filter(c => Date.now() - Date.parse(c.observedAt) <= TREND_FRESH_MS)
}
