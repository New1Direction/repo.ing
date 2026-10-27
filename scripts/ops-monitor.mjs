// Phone alerts for the indexers (owner, 2026-10-27). Runs on the indexer host every 2 minutes as the restricted chart role
// and pushes to the owner's ntfy topic when: the chart writer has not written for 10 minutes, the fee indexer is 10 minutes
// behind trades the chart writer already saw, the database is unreachable, a safety stop is set, or a Neon quota is past 80%.
// One push when a problem starts, a reminder every 2 hours while it lasts, one when it clears. Never sends secrets.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import pg from 'pg'

export const STALE_MS = 10 * 60_000
export const REMIND_MS = 2 * 60 * 60_000
export const QUOTA_ALERT = 0.8

// Each check gives a problem key and a plain-words message, or nothing.
export function problems({ now, db, chartObservedAt, feeBehind, stops = [], quotas = [] }) {
  if (db?.error) return [{ key: 'database', text: `Database unreachable (${db.error}). Site markets, trades and charts are failing.` }]
  const found = []
  if (!chartObservedAt || now - chartObservedAt > STALE_MS) {
    const mins = chartObservedAt ? Math.floor((now - chartObservedAt) / 60_000) : null
    found.push({ key: 'chart-stale', text: `Chart writer has not written for ${mins ?? 'an unknown number of'} minutes. Charts will show "being verified".` })
  }
  if (feeBehind?.count > 0) {
    const mins = Math.floor((now - feeBehind.oldest) / 60_000)
    found.push({ key: 'fee-stale', text: `Fee indexer is behind: ${feeBehind.count} trade(s) up to ${mins} minutes old are not in fee accounting.` })
  }
  for (const stop of stops) found.push({ key: `stop:${stop}`, text: `Safety stop set: ${stop}. It stays stopped until someone clears it.` })
  for (const q of quotas) if (q.limit > 0 && q.used / q.limit >= QUOTA_ALERT) {
    found.push({ key: `quota:${q.name}`, text: `Neon ${q.name} at ${Math.round(100 * q.used / q.limit)}% of the plan limit.` })
  }
  return found
}

// What to push now, given the last state: new problems, 2-hourly reminders, and cleared ones.
export function decide(state, current, now) {
  const open = { ...(state.open ?? {}) }, pushes = []
  for (const p of current) {
    const seen = open[p.key]
    if (!seen) pushes.push({ title: 'repo.ing problem', text: p.text, priority: 'high' })
    else if (now - seen.lastSent >= REMIND_MS) pushes.push({ title: 'repo.ing still broken', text: p.text, priority: 'high' })
    else continue
    open[p.key] = { since: seen?.since ?? now, lastSent: now }
  }
  for (const key of Object.keys(open)) if (!current.some(p => p.key === key)) {
    pushes.push({ title: 'repo.ing recovered', text: `Cleared: ${key} (was down ${Math.round((now - open[key].since) / 60_000)} min).`, priority: 'default' })
    delete open[key]
  }
  return { state: { open }, pushes }
}

async function readDatabase(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000, query_timeout: 20_000 })
  try {
    await client.connect()
    const { rows: [chart] } = await client.query('select max(checked_at) as at from recovery_charts.observations')
    // Only pools the fee indexer tracks: a trade older than 10 minutes past its pool's cursor was missed.
    const { rows: [fee] } = await client.query(`select count(*)::int as count, min(t.traded_at) as oldest from public.trade_events t
      join public.pool_fee_cursors c on c.pool = t.pool
      where t.slot > c.last_slot and t.traded_at < now() - interval '10 minutes' and t.traded_at > now() - interval '2 days'`)
    return { chartObservedAt: chart.at?.getTime() ?? null, feeBehind: { count: fee.count, oldest: fee.oldest?.getTime() ?? null } }
  } catch (error) {
    return { db: { error: error.code ? `code ${error.code}` : 'no connection' } }
  } finally { await client.end().catch(() => {}) }
}

function safetyStops() {
  const stops = []
  if (existsSync('/var/lib/repoing-chart-indexer/failed')) stops.push('chart writer')
  try { execFileSync('systemctl', ['is-active', '--quiet', 'repoing-chart-indexer.timer']) } catch { stops.push('chart writer timer off') }
  return stops
}

// Neon's project usage against the plan limits the owner sets in the monitor env (NEON_LIMIT_*); skipped until configured.
async function neonQuotas(env) {
  if (!env.NEON_API_KEY || !env.NEON_PROJECT_ID) return []
  const response = await fetch(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(env.NEON_PROJECT_ID)}`,
    { headers: { authorization: `Bearer ${env.NEON_API_KEY}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) return [{ name: 'usage check', used: 1, limit: 1 }]
  const { project } = await response.json()
  return [
    { name: 'compute hours', used: Number(project.compute_time_seconds ?? 0) / 3600, limit: Number(env.NEON_LIMIT_COMPUTE_HOURS ?? 0) },
    { name: 'storage', used: Number(project.synthetic_storage_size ?? 0), limit: Number(env.NEON_LIMIT_STORAGE_BYTES ?? 0) },
    { name: 'data transfer', used: Number(project.data_transfer_bytes ?? 0), limit: Number(env.NEON_LIMIT_TRANSFER_BYTES ?? 0) },
  ]
}

async function push(env, { title, text, priority }) {
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, { method: 'POST', body: text,
    headers: { title, priority, tags: priority === 'high' ? 'rotating_light' : 'white_check_mark' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw Error(`ntfy refused the push (${response.status})`)
}

export async function main(env = process.env, now = Date.now()) {
  if (!env.NTFY_TOPIC || !env.RECOVERY_CHART_DATABASE_URL) throw Error('NTFY_TOPIC and RECOVERY_CHART_DATABASE_URL are required')
  const statePath = env.MONITOR_STATE ?? '/var/lib/repoing-monitor/state.json'
  const test = env.MONITOR_TEST === 'stale-chart'
  const reading = test ? { chartObservedAt: now - 11 * 60_000, feeBehind: { count: 0 } } : await readDatabase(env.RECOVERY_CHART_DATABASE_URL)
  const current = problems({ now, ...reading, stops: test ? [] : safetyStops(), quotas: test ? [] : await neonQuotas(env).catch(() => []) })
  if (test) {
    await push(env, { title: 'repo.ing TEST alert', text: `TEST (fake stale event): ${current[0].text}`, priority: 'high' })
    return { test: true, problems: current.map(p => p.key) }
  }
  const last = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
  const { state, pushes } = decide(last, current, now)
  for (const p of pushes) await push(env, p)
  writeFileSync(statePath, JSON.stringify(state))
  return { problems: current.map(p => p.key), pushed: pushes.length }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(result => console.log(JSON.stringify(result)), error => { console.error(`MONITOR_FAILED ${error.message}`); process.exitCode = 1 })
}
