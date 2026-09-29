export const CSP_REPORT_MAX_BYTES = 16 * 1024
const FIELD_MAX = 200, MAX_TRACKED_CLIENTS = 5000

// Naive in-process fixed-window limiter; per instance, which is enough to keep a noisy page from flooding logs.
export function createRateLimiter({ limit = 30, globalLimit = 300, windowMs = 60_000, now = Date.now } = {}) {
  let windowStart = now(), counts = new Map(), total = 0
  return key => {
    const t = now()
    if (t - windowStart >= windowMs) { windowStart = t; counts = new Map(); total = 0 }
    if (total >= globalLimit) return false
    const count = counts.get(key) ?? 0
    if (count >= limit) return false
    if (!counts.has(key) && counts.size >= MAX_TRACKED_CLIENTS) return false
    counts.set(key, count + 1); total++
    return true
  }
}

// Returns null when the body exceeds maxBytes, reading no further than that.
export async function readLimitedText(request, maxBytes = CSP_REPORT_MAX_BYTES) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return ''
  const reader = request.body.getReader(), chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Query strings can carry launch drafts or OAuth state, so only origin + path are logged.
const clean = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return '-'
  let text = String(value)
  try { const url = new URL(text); if (url.protocol.startsWith('http') || url.protocol.startsWith('ws')) text = url.origin + url.pathname } catch { /* keywords like 'inline' or 'eval' */ }
  return text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').slice(0, FIELD_MAX) || '-'
}

// Accepts the legacy report-uri body ({"csp-report": {...}}) and Reporting API arrays.
export function cspReportEntries(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const reports = Array.isArray(parsed) ? parsed.filter(r => r?.type === 'csp-violation').map(r => r.body) : [parsed?.['csp-report']]
  const entries = reports.filter(r => r && typeof r === 'object').slice(0, 10).map(r => {
    const line = r['line-number'] ?? r.lineNumber
    return { directive: clean(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive']), blocked: clean(r['blocked-uri'] ?? r.blockedURL),
      page: clean(r['document-uri'] ?? r.documentURL), source: clean(r['source-file'] ?? r.sourceFile), line: line ? clean(line) : null }
  })
  return entries.length ? entries : null
}

const entryLine = e => `csp-report directive=${e.directive} blocked=${e.blocked} page=${e.page} source=${e.source}${e.line ? `:${e.line}` : ''}`
export function summarizeCspReport(text) { return cspReportEntries(text)?.map(entryLine) ?? null }

const blockedHost = blocked => { try { return new URL(blocked).host || blocked } catch { return blocked } }

// Per-process view for /operations/health. Holds only the already-logged fields, bounded by maxReports
// and maxKeys, and resets on restart.
export function createCspStats({ maxReports = 200, maxKeys = 500, now = Date.now } = {}) {
  const since = now(), recent = [], hosts = new Map(), directives = new Map()
  let total = 0
  const bump = (map, key) => { if (map.has(key) || map.size < maxKeys) map.set(key, (map.get(key) ?? 0) + 1) }
  const top = (map, limit) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([key, count]) => ({ key, count }))
  return {
    record(entries) {
      for (const { directive, blocked, page } of entries) {
        total++
        bump(hosts, blockedHost(blocked)); bump(directives, directive)
        recent.push({ at: new Date(now()).toISOString(), directive, blocked, page })
        if (recent.length > maxReports) recent.shift()
      }
    },
    snapshot({ limit = 10 } = {}) {
      return { since: new Date(since).toISOString(), total, hosts: top(hosts, limit), directives: top(directives, limit), recent: recent.slice(-limit).reverse() }
    },
  }
}

// Route handlers and pages can load separate module copies, so the process-wide instance lives on globalThis.
export function cspStats() { return globalThis.__repoingCspStats ??= createCspStats() }

const clientKey = request => request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown'

export async function handleCspReport(request, { limiter, log = console.error, stats = null } = {}) {
  if (!limiter(clientKey(request))) return new Response(null, { status: 429 })
  const text = await readLimitedText(request)
  if (text === null) return new Response(null, { status: 413 })
  const entries = cspReportEntries(text)
  if (!entries) return new Response(null, { status: 400 })
  for (const entry of entries) log(entryLine(entry))
  stats?.record(entries)
  return new Response(null, { status: 204 })
}
