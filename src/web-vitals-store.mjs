// Real-user Core Web Vitals samples (web_vitals, migration 0038): written by POST /api/vitals, summarized for
// /operations/vitals. Rows older than retentionDays are deleted by the web service itself, at most once per pruneEveryMs
// per process, so no worker job is needed.
export const VITALS_RETENTION_DAYS = 14
const PRUNE_EVERY_MS = 60 * 60 * 1000

// p75 per route and metric over the last 24 h and 7 days (percentile_cont: linear interpolation), with sample counts.
export const VITALS_SUMMARY_SQL = `select route, metric,
    count(*) filter (where created_at >= now() - interval '24 hours')::int as "samplesDay",
    percentile_cont(0.75) within group (order by value) filter (where created_at >= now() - interval '24 hours') as "p75Day",
    count(*)::int as "samplesWeek",
    percentile_cont(0.75) within group (order by value) as "p75Week"
  from web_vitals where created_at >= now() - interval '7 days' and ($1::text is null or device = $1)
  group by route, metric order by route, metric`

export function createVitalsStore(pool, { now = Date.now, retentionDays = VITALS_RETENTION_DAYS, pruneEveryMs = PRUNE_EVERY_MS, onPruneError = () => {} } = {}) {
  let nextPrune = 0
  async function prune() {
    const { rowCount } = await pool.query('delete from web_vitals where created_at < now() - make_interval(days => $1)', [retentionDays])
    return rowCount
  }
  return {
    // One beacon: { route, device, metrics: [{ metric, value, rating }] } (already validated by parseVitalsBeacon).
    async record({ route, device, metrics }) {
      await pool.query(`insert into web_vitals(route, metric, value, rating, device)
        select $1, m.metric, m.value, m.rating, $2 from unnest($3::text[], $4::float8[], $5::text[]) as m(metric, value, rating)`,
      [route, device, metrics.map(m => m.metric), metrics.map(m => m.value), metrics.map(m => m.rating)])
      if (now() >= nextPrune) {
        nextPrune = now() + pruneEveryMs
        prune().catch(onPruneError)
      }
    },
    prune,
    async summary({ device = null } = {}) {
      return (await pool.query(VITALS_SUMMARY_SQL, [device])).rows
    },
  }
}
