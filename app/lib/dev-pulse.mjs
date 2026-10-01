import { promotionExcludedRepoIds } from './promotion-exclusions.mjs'

// Dev Pulse read side: what a repository's developers did on GitHub (collected by the worker, src/dev-pulse.mjs) plus
// repo.ing's own maintainer events, summarized for the token page, the price chart pins and the home ticker.
const HOUR = 3_600_000, DAY = 86_400_000
export const PULSE_DAYS = 14
const CHART_DAYS = 30, FEED_LIMIT = 10
const iso = ms => new Date(ms).toISOString()
const at = value => value instanceof Date ? value.toISOString() : value
const hourStart = ms => Math.floor(ms / HOUR) * HOUR
const sol = lamports => {
  const value = BigInt(lamports)
  return `${value / 1_000_000_000n}.${String(value % 1_000_000_000n).padStart(9, '0').slice(0, 4)}`.replace(/\.?0+$/, '')
}

// One item per UTC hour of commits: "5 commits", the newest message as the detail.
export function commitHours(commits) {
  const hours = new Map()
  for (const commit of commits) {
    const key = hourStart(Date.parse(commit.at))
    const group = hours.get(key) ?? { count: 0, latest: commit }
    group.count++
    if (Date.parse(commit.at) > Date.parse(group.latest.at)) group.latest = commit
    hours.set(key, group)
  }
  return [...hours].map(([hour, { count, latest }]) => ({ id: `commits:${iso(hour)}`, kind: 'commits', at: latest.at,
    title: `${count} commit${count === 1 ? '' : 's'}`, detail: latest.title, url: latest.url, amount: count }))
}

export function summarizePulse({ now = Date.now(), state, events = [], release = null, starHours = [], boundAt = null, payouts = [], repoId = null }) {
  if (!state) return { status: 'pending', checkedAt: null }
  const rows = events.map(event => ({ ...event, at: at(event.at) }))
  const commits = rows.filter(event => event.kind === 'commit')
  const merges = rows.filter(event => event.kind === 'merge')
  const releases = rows.filter(event => event.kind === 'release')
  const latestRelease = release ? { ...release, at: at(release.at) } : null
  const since = days => now - days * DAY
  const after = (list, ms) => list.filter(event => Date.parse(event.at) >= ms)
  const lastCodeAt = [...commits, ...merges, ...releases, ...latestRelease ? [latestRelease] : []]
    .map(event => Date.parse(event.at)).filter(Number.isFinite).reduce((latest, time) => Math.max(latest, time), Number.NEGATIVE_INFINITY)
  const quietFor = now - lastCodeAt
  const status = quietFor < DAY ? 'shipping' : quietFor < 7 * DAY ? 'active' : Number.isFinite(lastCodeAt) ? 'quiet' : 'none'
  const today = Math.floor(now / DAY) * DAY
  const days = Array.from({ length: PULSE_DAYS }, (_, index) => {
    const start = today - (PULSE_DAYS - 1 - index) * DAY
    return { day: iso(start).slice(0, 10), commits: commits.filter(event => { const time = Date.parse(event.at); return time >= start && time < start + DAY }).length }
  })
  // Stars today: the current total minus the last hourly snapshot from 24 hours ago (or the oldest one while Dev Pulse has
  // watched for less than a day, which makes the figure a lower bound).
  const snapshots = starHours.map(item => ({ time: Date.parse(at(item.hour)), total: item.starsTotal }))
    .filter(item => Number.isFinite(item.time) && Number.isSafeInteger(item.total)).sort((a, b) => a.time - b.time)
  const dayAgo = hourStart(now - DAY)
  const base = snapshots.findLast(item => item.time <= dayAgo) ?? snapshots[0] ?? null
  const stars = Number.isSafeInteger(state.stars) ? { total: state.stars, today: base ? Math.max(0, state.stars - base.total) : null,
    partial: !base || base.time > dayAgo } : null
  const hn = after(rows.filter(event => event.kind === 'hn'), since(CHART_DAYS)).sort((a, b) => b.amount - a.amount)[0] ?? null
  // A merged pull request already lands its commits on the default branch: the feed and chart show the merge, not the
  // same commits again (or GitHub's "Merge pull request" commits). Commit counts still include them.
  const merged = merges.map(event => ({ title: event.title.replace(/^#\d+\s+/, '').trim().toLowerCase().slice(0, 60), time: Date.parse(event.at) }))
  const shown = commits.filter(event => {
    const title = event.title.trim().toLowerCase()
    if (/^merge (pull request|branch|remote-tracking branch) /.test(title)) return false
    return !merged.some(merge => merge.title && title.startsWith(merge.title) && Math.abs(Date.parse(event.at) - merge.time) <= 15 * 60_000)
  })
  const extra = [
    ...boundAt ? [{ id: 'verified', kind: 'verified', at: at(boundAt), title: 'Maintainer verified on repo.ing', detail: 'Payout wallet set with GitHub admin access', url: null, amount: null }] : [],
    ...payouts.map(payout => ({ id: `paid:${payout.signature}`, kind: 'paid', at: at(payout.settledAt), title: `Builder claimed ${sol(payout.amount)} SOL`,
      detail: 'Fees paid to the verified payout wallet', url: `https://solscan.io/tx/${payout.signature}`, amount: null })),
  ]
  const items = [...commitHours(shown), ...merges, ...releases, ...rows.filter(event => ['stars', 'hn'].includes(event.kind)), ...extra]
    .map(({ id, sourceId, kind, at: time, title, detail = null, url = null, amount = null }) => ({ id: id ?? `${kind}:${sourceId}`, kind, at: time, title, detail, url, amount }))
    .filter(item => Number.isFinite(Date.parse(item.at)) && Date.parse(item.at) <= now + 5 * 60_000)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return {
    status, lastCodeAt: Number.isFinite(lastCodeAt) ? iso(lastCodeAt) : null, fullName: state.fullName ?? null,
    commits24h: after(commits, since(1)).length, commits7d: after(commits, since(7)).length, days,
    merged7d: after(merges, since(7)).length, release: latestRelease, stars,
    hn: hn ? { title: hn.title, points: hn.amount, url: hn.url, at: hn.at } : null,
    maintainer: { verified: Boolean(boundAt), since: boundAt ? at(boundAt) : null, claimHref: repoId ? `/claim/${repoId}` : null },
    feed: items.slice(0, FEED_LIMIT),
    events: items.filter(item => Date.parse(item.at) >= since(CHART_DAYS)).map(item => ({ ...item, time: Math.floor(Date.parse(item.at) / 1000) }))
      .sort((a, b) => a.time - b.time),
    checkedAt: at(state.checkedAt) ?? null,
  }
}

export async function readRepoPulse(pool, repoId, now = Date.now()) {
  if (!pool || !/^\d+$/.test(String(repoId))) return null
  const id = String(repoId), since = iso(now - CHART_DAYS * DAY)
  try {
    const [state, events, release, hours, binding, payouts] = await Promise.all([
      pool.query(`select full_name as "fullName", stars, checked_at as "checkedAt"
        from repo_pulse_state where github_repo_id = $1 and checked_at is not null`, [id]),
      pool.query(`select kind, source_id as "sourceId", occurred_at as at, title, detail, url, amount from repo_pulse_events
        where github_repo_id = $1 and occurred_at >= $2 order by occurred_at desc limit 500`, [id, since]),
      pool.query(`select title, detail, url, occurred_at as at from repo_pulse_events where github_repo_id = $1 and kind = 'release'
        order by occurred_at desc limit 1`, [id]),
      pool.query(`select hour, stars_total as "starsTotal" from repo_pulse_star_hours where github_repo_id = $1 and hour >= $2`, [id, iso(now - 2 * DAY)]),
      pool.query(`select bound_at as "boundAt" from repo_beneficiaries where github_repo_id = $1`, [id]),
      pool.query(`select amount_base_units::text as amount, settled_at as "settledAt", claim_signature as signature from repo_claims
        where github_repo_id = $1 and status = 'settled' and settled_at >= $2 order by settled_at desc limit 20`, [id, since]),
    ])
    return summarizePulse({ now, state: state.rows[0], events: events.rows, release: release.rows[0] ?? null, starHours: hours.rows,
      boundAt: binding.rows[0]?.boundAt ?? null, payouts: payouts.rows, repoId: id })
  } catch (error) {
    if (error?.code === '42P01') return null
    throw error
  }
}

const TICKER_KINDS = new Set(['release', 'merge', 'stars', 'hn', 'commits', 'verified'])
export function tickerText(item) {
  if (item.kind === 'release') return `released ${item.title}`
  if (item.kind === 'merge') return `merged ${item.title}`
  if (item.kind === 'commits') return `pushed ${item.amount} commit${item.amount === 1 ? '' : 's'} today`
  if (item.kind === 'hn') return `is on Hacker News · ${Number(item.amount).toLocaleString('en-US')} points`
  if (item.kind === 'verified') return 'maintainer verified on repo.ing'
  if (item.kind === 'stars') return item.title.startsWith('+') ? item.title : `hit ${item.title}`
  return item.title
}

// Newest first, at most two items per repository so one busy repo cannot fill the ticker, never a do-not-promote repo.
export function selectTicker(items, { excluded = new Set(), limit = 14, perRepo = 2 } = {}) {
  const counts = new Map()
  return items.filter(item => TICKER_KINDS.has(item.kind) && !excluded.has(String(item.repoId)) && Number.isFinite(Date.parse(at(item.at))))
    .sort((a, b) => Date.parse(at(b.at)) - Date.parse(at(a.at)))
    .filter(item => { const seen = counts.get(item.repoId) ?? 0; counts.set(item.repoId, seen + 1); return seen < perRepo })
    .slice(0, limit)
    .map(item => ({ id: `${item.repoId}:${item.kind}:${item.key ?? at(item.at)}`, kind: item.kind, at: at(item.at), text: tickerText(item),
      fullName: item.fullName, symbol: item.symbol, href: `/token/${item.mint}` }))
}

export async function readPulseTicker(pool, { now = Date.now(), excluded = promotionExcludedRepoIds(), limit = 14 } = {}) {
  if (!pool) return []
  const live = `(select distinct on (github_repo_id) github_repo_id, mint, token_symbol from markets where status = 'confirmed'
    order by github_repo_id, created_at desc)`
  try {
    const [events, commits, verified] = await Promise.all([
      pool.query(`select e.github_repo_id::text as "repoId", e.kind, e.source_id as key, e.title, e.amount, e.occurred_at as at,
          m.mint, m.token_symbol as symbol, r.full_name as "fullName"
        from repo_pulse_events e join ${live} m on m.github_repo_id = e.github_repo_id join repositories r on r.github_repo_id = e.github_repo_id
        where e.kind <> 'commit' and e.occurred_at >= $1 and e.occurred_at <= $2 order by e.occurred_at desc limit 80`, [iso(now - 3 * DAY), iso(now + 5 * 60_000)]),
      pool.query(`select e.github_repo_id::text as "repoId", 'commits' as kind, count(*)::int as amount, max(e.occurred_at) as at,
          m.mint, m.token_symbol as symbol, r.full_name as "fullName"
        from repo_pulse_events e join ${live} m on m.github_repo_id = e.github_repo_id join repositories r on r.github_repo_id = e.github_repo_id
        where e.kind = 'commit' and e.occurred_at >= $1 group by e.github_repo_id, m.mint, m.token_symbol, r.full_name
        having count(*) >= 2 order by max(e.occurred_at) desc limit 30`, [iso(now - DAY)]),
      pool.query(`select b.github_repo_id::text as "repoId", 'verified' as kind, b.bound_at as at, m.mint, m.token_symbol as symbol, r.full_name as "fullName"
        from repo_beneficiaries b join ${live} m on m.github_repo_id = b.github_repo_id join repositories r on r.github_repo_id = b.github_repo_id
        where b.bound_at >= $1`, [iso(now - 7 * DAY)]),
    ])
    return selectTicker([...events.rows, ...commits.rows, ...verified.rows], { excluded, limit })
  } catch (error) {
    if (error?.code === '42P01') return []
    throw error
  }
}
