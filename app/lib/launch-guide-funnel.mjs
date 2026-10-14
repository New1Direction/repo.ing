// Guided launch conversion events (docs/LAUNCH_GUIDE.md#measurement): shared policy for attribution (?src= on links into
// /launches/new), the browser beacon (POST /api/launch-guide/events) and /operations/funnel. Client-safe: no imports.
// An event carries only its name, a step, a source and an outcome from fixed lists, and a public repository id: no GitHub
// login or id, wallet, cookie, URL, query or IP ever reaches storage. A browser that sends Global Privacy Control or Do Not
// Track sends nothing, and the server records nothing for such a request.
export const GUIDE_EVENTS_ENDPOINT = '/api/launch-guide/events'
export const GUIDE_EVENTS_MAX_BYTES = 256

// Where a visit to the guide came from.
export const GUIDE_SOURCES = Object.freeze({
  launch: 'Launch page', repo: 'Repository launch page', calendar: 'Launch calendar', manage: 'Schedule a launch',
  builders: 'Builder dashboard', claim: 'Claim page', 'opt-out': 'Opt-out page', agents: 'Agents and README buttons', cli: 'repoing CLI',
  docs: 'Documentation', x: 'X',
})
export const guideSource = value => typeof value === 'string' && Object.hasOwn(GUIDE_SOURCES, value) ? value : null
export const guideHref = (source, repoId = null) => {
  const params = new URLSearchParams()
  if (repoId !== null && /^[1-9]\d{0,15}$/.test(String(repoId))) params.set('repo', String(repoId))
  if (guideSource(source)) params.set('src', source)
  const query = params.toString()
  return `/launches/new${query ? `?${query}` : ''}`
}

export const GUIDE_STEPS = Object.freeze(['github', 'repository', 'preflight', 'plan', 'disclose', 'preview', 'publish'])
// Browser events: a page view and each step shown.
export const GUIDE_BEACON_EVENTS = Object.freeze(['guide_view', 'step_view'])
// Server events, recorded by the routes themselves.
export const GUIDE_SERVER_EVENTS = Object.freeze(['github_connect', 'github_result', 'repo_selected', 'preflight_run', 'draft_resumed', 'publish', 'draft_discarded'])
export const GUIDE_EVENTS = Object.freeze([...GUIDE_BEACON_EVENTS, ...GUIDE_SERVER_EVENTS])
// github_result: verified | cancelled | failed. repo_selected: admin | not-admin | no-access | failed. preflight_run: the verdict
// (ready | needs-action | blocked) or unavailable. publish: scheduled | refused | failed.
export const GUIDE_OUTCOMES = Object.freeze(['verified', 'cancelled', 'failed', 'admin', 'not-admin', 'no-access', 'ready', 'needs-action', 'blocked',
  'unavailable', 'scheduled', 'refused'])
const OUTCOMES = new Set(GUIDE_OUTCOMES)
const REPO_ID = /^[1-9]\d{0,15}$/

// Strict beacon shape: {"event":"step_view","step":"plan","source":"launch"|null,"repoId":"123"|null}. Throws on anything else.
export function parseGuideBeacon(text) {
  if (typeof text !== 'string' || !text || text.length > GUIDE_EVENTS_MAX_BYTES) throw Error('INVALID_GUIDE_EVENT')
  let body
  try { body = JSON.parse(text) } catch { throw Error('INVALID_GUIDE_EVENT') }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['event', 'step', 'source', 'repoId'].includes(key)) ||
      !GUIDE_BEACON_EVENTS.includes(body.event)) throw Error('INVALID_GUIDE_EVENT')
  const step = body.step ?? null, source = body.source ?? null, repoId = body.repoId ?? null
  if ((body.event === 'step_view') !== (step !== null) || (step !== null && !GUIDE_STEPS.includes(step))) throw Error('INVALID_GUIDE_EVENT')
  if (source !== null && !guideSource(source)) throw Error('INVALID_GUIDE_EVENT')
  if (repoId !== null && !(typeof repoId === 'string' && REPO_ID.test(repoId))) throw Error('INVALID_GUIDE_EVENT')
  return { event: body.event, step, source, repoId, outcome: null }
}

// A server event, checked the same way before it is stored. Unknown values become null; an unknown event throws.
export function guideEvent({ event, step = null, source = null, repoId = null, outcome = null }) {
  if (!GUIDE_EVENTS.includes(event)) throw Error('INVALID_GUIDE_EVENT')
  return { event, step: GUIDE_STEPS.includes(step) ? step : null, source: guideSource(source),
    repoId: repoId !== null && REPO_ID.test(String(repoId)) ? String(repoId) : null, outcome: OUTCOMES.has(outcome) ? outcome : null }
}

// Global Privacy Control or Do Not Track on a request: record nothing for it.
export const trackingRefused = headers => headers?.get?.('sec-gpc') === '1' || headers?.get?.('dnt') === '1'

// Store summary rows ({ event, step, outcome, source, day, week, month }) → the operator view: per event (and outcome) totals,
// step views, and per source the views, previews and published schedules.
export function guideSummary(rows) {
  const totals = {}, steps = {}, sources = new Map()
  const add = (target, key, row) => {
    const entry = target[key] ??= { day: 0, week: 0, month: 0 }
    entry.day += row.day; entry.week += row.week; entry.month += row.month
  }
  for (const row of rows) {
    add(totals, row.outcome ? `${row.event}:${row.outcome}` : row.event, row)
    if (row.event === 'step_view' && row.step) add(steps, row.step, row)
    const source = row.source ?? 'direct'
    const entry = sources.get(source) ?? { source, views: { day: 0, week: 0, month: 0 }, preflights: { day: 0, week: 0, month: 0 }, published: { day: 0, week: 0, month: 0 } }
    if (row.event === 'guide_view') add(entry, 'views', row)
    else if (row.event === 'preflight_run') add(entry, 'preflights', row)
    else if (row.event === 'publish' && row.outcome === 'scheduled') add(entry, 'published', row)
    else continue
    sources.set(source, entry)
  }
  const count = (key, window = 'month') => totals[key]?.[window] ?? 0
  const step = (key, window = 'month') => steps[key]?.[window] ?? 0
  return { count, step, sources: [...sources.values()].sort((a, b) => b.views.month - a.views.month || b.preflights.month - a.preflights.month || a.source.localeCompare(b.source)) }
}
