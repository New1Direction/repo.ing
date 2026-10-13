// Maintainer claim funnel: shared policy for attribution (?src= on claim links), GitHub verification outcomes, the
// browser beacon (app/components/funnel-beacon.jsx, POST /api/funnel) and /operations/funnel. Client-safe: no imports.
// An event carries only its name, a source from a fixed list, a public repository id and an outcome: no URL, query,
// GitHub login, wallet, cookie or IP ever reaches storage. Verification, wallet and payout stages are read from the
// existing ledgers (src/funnel-store.mjs), not tracked per person.
export const FUNNEL_ENDPOINT = '/api/funnel'
export const FUNNEL_MAX_BYTES = 256

// Where a claim visit came from. ?ref= is the wallet referral (app/lib/referral.mjs), so attribution uses ?src=.
export const FUNNEL_SOURCES = Object.freeze({
  waiting: 'Waiting board', x: 'Tag on X', invite: 'GitHub issue invite', share: 'Shared invitation', token: 'Token page',
  builders: 'Builder dashboard', lookup: 'Owner lookup', admin: 'Shared with an admin',
})
export const funnelSource = value => typeof value === 'string' && Object.hasOwn(FUNNEL_SOURCES, value) ? value : null

// Adds ?src= to a claim link (absolute or root-relative), keeping anything already there.
export function withFunnelSource(href, source) {
  if (!funnelSource(source)) return href
  const [path, hash] = String(href).split('#')
  return `${path}${path.includes('?') ? '&' : '?'}src=${source}${hash === undefined ? '' : `#${hash}`}`
}
export const claimHref = (repoId, source) => withFunnelSource(`/claim/${encodeURIComponent(String(repoId))}`, source)

// What a GitHub sign-in ended as. 'not-admin': GitHub confirmed the account, but it is not a current admin.
export const VERIFY_OUTCOMES = Object.freeze(['verified', 'not-admin', 'cancelled', 'failed'])
// Browser events (the beacon) and server events (recorded by the routes themselves).
export const BEACON_EVENTS = Object.freeze(['claim_view', 'builders_view', 'waiting_view'])
export const SERVER_EVENTS = Object.freeze(['verify_start', 'app_access_required', 'verify_result', 'builders_connect', 'builders_result', 'owner_lookup'])
export const FUNNEL_EVENTS = Object.freeze([...BEACON_EVENTS, ...SERVER_EVENTS])
export const LOOKUP_OUTCOMES = Object.freeze(['found', 'none'])
const OUTCOMES = new Set([...VERIFY_OUTCOMES, ...LOOKUP_OUTCOMES])

// GitHub's collaborator permission names; anything else is shown as no access.
const PERMISSIONS = new Set(['maintain', 'write', 'triage', 'read', 'none'])
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

// The callback's answer → { outcome, error, detail }. githubError is GitHub's own ?error= (access_denied when the person
// pressed Cancel); result is the verifier's answer; failed is true when verification threw.
export function verificationOutcome({ githubError = null, result = null, failed = false, dashboard = false } = {}) {
  if (githubError === 'access_denied') return { outcome: 'cancelled', error: 'github-cancelled', detail: null }
  if (githubError || failed || !result) return { outcome: 'failed', error: 'verification-failed', detail: null }
  if (dashboard || (result.verified && result.permission === 'admin')) return { outcome: 'verified', error: null, detail: null }
  return { outcome: 'not-admin', error: 'not-admin', detail: { github: LOGIN.test(result.githubLogin ?? '') ? result.githubLogin : null,
    permission: PERMISSIONS.has(result.permission) ? result.permission : 'none' } }
}

// The not-admin details from the claim page's query, re-validated (anyone can type a URL; this only changes their own view).
export function notAdminDetail(query) {
  return { github: LOGIN.test(query?.github ?? '') ? query.github : null, permission: PERMISSIONS.has(query?.permission) ? query.permission : 'none' }
}

const PERMISSION_TEXT = { maintain: 'maintain', write: 'write', triage: 'triage', read: 'read', none: 'no' }
export const permissionText = permission => PERMISSION_TEXT[permission] ?? 'no'

// Claim page and dashboard messages for each verification error code.
export function verificationMessage(code) {
  if (code === 'github-cancelled') return 'GitHub sign-in was cancelled, so nothing was verified or shared. Verify with GitHub when you’re ready.'
  if (code === 'not-admin') return 'GitHub confirmed your account, but it is not a current admin of this repository, so it cannot claim.'
  if (code === 'verification-failed') return 'GitHub could not confirm access just now. This is usually temporary: verify again. Nothing was claimed.'
  return null
}
export const VERIFICATION_ERRORS = Object.freeze(['github-cancelled', 'not-admin', 'verification-failed'])

// Strict beacon shape: {"event":"claim_view","source":"waiting"|null,"repoId":"123"|null}. Throws on anything else.
export function parseFunnelBeacon(text) {
  if (typeof text !== 'string' || !text || text.length > FUNNEL_MAX_BYTES) throw Error('INVALID_FUNNEL')
  let body
  try { body = JSON.parse(text) } catch { throw Error('INVALID_FUNNEL') }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['event', 'source', 'repoId'].includes(key)) ||
      !BEACON_EVENTS.includes(body.event)) throw Error('INVALID_FUNNEL')
  const source = body.source ?? null, repoId = body.repoId ?? null
  if (source !== null && !funnelSource(source)) throw Error('INVALID_FUNNEL')
  if (repoId !== null && !(typeof repoId === 'string' && /^[1-9]\d{0,15}$/.test(repoId))) throw Error('INVALID_FUNNEL')
  if ((body.event === 'claim_view') !== (repoId !== null)) throw Error('INVALID_FUNNEL')
  return { event: body.event, source, repoId, outcome: null }
}

// A server event, checked the same way before it is stored.
export function funnelEvent({ event, source = null, repoId = null, outcome = null }) {
  if (!FUNNEL_EVENTS.includes(event)) throw Error('INVALID_FUNNEL')
  return { event, source: funnelSource(source), repoId: repoId !== null && /^[1-9]\d{0,15}$/.test(String(repoId)) ? String(repoId) : null,
    outcome: OUTCOMES.has(outcome) ? outcome : null }
}

// Rows from the store's summary query ({ event, outcome, source, day, week, month }) → the operator view: per event and
// outcome totals, and per source the claim-page views, verification starts and verified results.
export function funnelSummary(rows) {
  const totals = {}, sources = new Map()
  const add = (target, key, row) => {
    const entry = target[key] ??= { day: 0, week: 0, month: 0 }
    entry.day += row.day; entry.week += row.week; entry.month += row.month
  }
  for (const row of rows) {
    add(totals, row.outcome ? `${row.event}:${row.outcome}` : row.event, row)
    const source = row.source ?? 'direct'
    const entry = sources.get(source) ?? { source, views: { day: 0, week: 0, month: 0 }, starts: { day: 0, week: 0, month: 0 }, verified: { day: 0, week: 0, month: 0 } }
    if (row.event === 'claim_view') add(entry, 'views', row)
    else if (row.event === 'verify_start') add(entry, 'starts', row)
    else if (row.event === 'verify_result' && row.outcome === 'verified') add(entry, 'verified', row)
    else continue
    sources.set(source, entry)
  }
  const count = (key, window = 'month') => totals[key]?.[window] ?? 0
  return { count, sources: [...sources.values()].sort((a, b) => b.views.month - a.views.month || b.starts.month - a.starts.month || a.source.localeCompare(b.source)) }
}

// Owner lookup (/builders?owner=): a GitHub user or organization name, or null.
export const ownerQuery = value => typeof value === 'string' && LOGIN.test(value.trim()) ? value.trim() : null
