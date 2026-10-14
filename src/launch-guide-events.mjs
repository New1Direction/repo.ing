import { guideEvent } from '../app/lib/launch-guide-funnel.mjs'

// Guided launch conversion events (launch_guide_events, migration 0073, docs/LAUNCH_GUIDE.md#measurement): an event, a step, a source
// and an outcome from fixed lists and a public repository id; nothing identifies a person. Kept apart from src/launch-guide.mjs so the
// GitHub sign-in routes can record without loading the preflight. Rows older than retentionDays are deleted by the web service itself,
// at most once an hour per process.
export const GUIDE_EVENT_RETENTION_DAYS = 180
const PRUNE_EVERY_MS = 60 * 60_000

export const GUIDE_SUMMARY_SQL = `select event, step, outcome, source,
    count(*) filter (where created_at >= now() - interval '24 hours')::int as day,
    count(*) filter (where created_at >= now() - interval '7 days')::int as week,
    count(*)::int as month
  from launch_guide_events where created_at >= now() - interval '30 days'
  group by event, step, outcome, source order by event, step, outcome, source`

export function createGuideEvents(pool, { now = Date.now, retentionDays = GUIDE_EVENT_RETENTION_DAYS, onPruneError = () => {} } = {}) {
  let nextPrune = 0
  const prune = async () => (await pool.query('delete from launch_guide_events where created_at < now() - make_interval(days => $1)', [retentionDays])).rowCount
  return {
    // One event, already checked by parseGuideBeacon or guideEvent.
    async record({ event, step = null, source = null, repoId = null, outcome = null }) {
      await pool.query('insert into launch_guide_events(event, step, source, repo_id, outcome) values ($1, $2, $3, $4, $5)', [event, step, source, repoId, outcome])
      if (now() >= nextPrune) { nextPrune = now() + PRUNE_EVERY_MS; prune().catch(onPruneError) }
    },
    prune,
    async summary() { return (await pool.query(GUIDE_SUMMARY_SQL)).rows },
  }
}
const sharedEvents = new WeakMap()
export function guideEvents(pool) {
  if (!sharedEvents.has(pool)) sharedEvents.set(pool, createGuideEvents(pool, { onPruneError: () => console.warn('launch_guide_events_prune_failed') }))
  return sharedEvents.get(pool)
}
// Server events, best effort: a malformed event, a refused tracking preference or a failed write never changes a response.
export async function recordGuideEvent(pool, event, { refused = false } = {}) {
  if (!pool || refused) return false
  try { await guideEvents(pool).record(guideEvent(event)); return true } catch { return false }
}
