// Real-user Core Web Vitals: shared policy for the browser reporter (app/components/web-vitals.jsx), POST /api/vitals
// and /operations/vitals. Client-safe: no imports. A beacon carries only a route pattern and metric values: no URL, query,
// wallet, cookie or IP ever leaves the page or reaches storage.
export const VITALS_ENDPOINT = '/api/vitals'
export const VITALS_SAMPLE_RATE = 0.25
export const VITALS_MAX_BYTES = 1024
export const VITAL_METRICS = Object.freeze(['LCP', 'INP', 'CLS', 'FCP', 'TTFB'])
// web.dev thresholds: good <= first, poor > second. CLS is unitless; the rest are milliseconds.
export const VITAL_THRESHOLDS = Object.freeze({ LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], FCP: [1800, 3000], TTFB: [800, 1800] })
const MAX_VALUE = Object.freeze({ LCP: 600_000, INP: 600_000, CLS: 100, FCP: 600_000, TTFB: 600_000 })

// Every page route of the app as its pattern; anything else (a 404, a route added later) reports as /other.
const STATIC_ROUTES = new Set(['/', '/about', '/agents', '/builders', '/builders/reminders', '/discoverers', '/explore', '/find-repos',
  '/how-it-works', '/launch', '/operations/fees', '/operations/graduation', '/operations/health', '/operations/invites',
  '/operations/trends', '/operations/vitals', '/stats', '/waiting', '/wallet', '/ja'])
const DYNAMIC_ROUTES = [
  [/^\/token\/[^/]+\/return\/[^/]+$/, '/token/[mint]/return/[pct]'],
  [/^\/token\/[^/]+$/, '/token/[mint]'],
  [/^\/claim\/[^/]+$/, '/claim/[repo]'],
  [/^\/launch\/[^/]+$/, '/launch/[repo]'],
]
export const VITAL_ROUTES = Object.freeze([...STATIC_ROUTES, ...DYNAMIC_ROUTES.map(([, pattern]) => pattern), '/other'])
const KNOWN_ROUTES = new Set(VITAL_ROUTES)

export function vitalsRoute(pathname) {
  const path = String(pathname ?? '').split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  if (STATIC_ROUTES.has(path)) return path
  return DYNAMIC_ROUTES.find(([pattern]) => pattern.test(path))?.[1] ?? '/other'
}

// One decision per page load: about a quarter of loads report, the rest send nothing.
export const sampleVitals = (random = Math.random, rate = VITALS_SAMPLE_RATE) => random() < rate

export function vitalsRating(metric, value) {
  const [good, poor] = VITAL_THRESHOLDS[metric]
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor'
}

// A User-Agent heuristic, stored as a class only (the header itself is never kept).
export const deviceClass = userAgent => /Mobi|Android|iPhone|iPad|iPod/i.test(String(userAgent ?? '')) ? 'mobile' : 'desktop'

// Strict beacon shape: {"route":"/token/[mint]","metrics":[{"name":"LCP","value":1234.5}, ...]}, each metric at most once.
// Throws on anything else; values are rounded (ms to 0.1, CLS to 0.0001).
export function parseVitalsBeacon(text) {
  if (typeof text !== 'string' || !text || text.length > VITALS_MAX_BYTES) throw Error('INVALID_VITALS')
  let body
  try { body = JSON.parse(text) } catch { throw Error('INVALID_VITALS') }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'route' && key !== 'metrics') ||
      !KNOWN_ROUTES.has(body.route) || !Array.isArray(body.metrics) || !body.metrics.length || body.metrics.length > VITAL_METRICS.length) throw Error('INVALID_VITALS')
  const seen = new Set()
  const metrics = body.metrics.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => key !== 'name' && key !== 'value')) throw Error('INVALID_VITALS')
    const { name, value } = entry
    if (!VITAL_METRICS.includes(name) || seen.has(name) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_VALUE[name]) throw Error('INVALID_VITALS')
    seen.add(name)
    const rounded = name === 'CLS' ? Math.round(value * 10_000) / 10_000 : Math.round(value * 10) / 10
    return { metric: name, value: rounded, rating: vitalsRating(name, rounded) }
  })
  return { route: body.route, metrics }
}

// Rows from the store's summary query → one entry per route with p75, rating and sample count per metric for the last
// 24 h and 7 days, busiest routes first.
export function vitalsSummary(rows) {
  const routes = new Map()
  for (const row of rows) {
    const route = routes.get(row.route) ?? { route: row.route, metrics: {} }
    route.metrics[row.metric] = { day: windowStats(row.metric, row.p75Day, row.samplesDay), week: windowStats(row.metric, row.p75Week, row.samplesWeek) }
    routes.set(row.route, route)
  }
  return [...routes.values()].sort((a, b) => weekSamples(b) - weekSamples(a) || a.route.localeCompare(b.route))
}
function windowStats(metric, value, samples) {
  const p75 = samples > 0 && value !== null && Number.isFinite(Number(value)) ? Number(value) : null
  return { p75, samples, rating: p75 === null ? null : vitalsRating(metric, p75) }
}
const weekSamples = route => Object.values(route.metrics).reduce((sum, metric) => sum + metric.week.samples, 0)
