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
export function summarizeCspReport(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const reports = Array.isArray(parsed) ? parsed.filter(r => r?.type === 'csp-violation').map(r => r.body) : [parsed?.['csp-report']]
  const lines = reports.filter(r => r && typeof r === 'object').slice(0, 10).map(r => {
    const directive = r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive']
    const blocked = r['blocked-uri'] ?? r.blockedURL
    const page = r['document-uri'] ?? r.documentURL
    const source = r['source-file'] ?? r.sourceFile
    const line = r['line-number'] ?? r.lineNumber
    return `csp-report directive=${clean(directive)} blocked=${clean(blocked)} page=${clean(page)} source=${clean(source)}${line ? `:${clean(line)}` : ''}`
  })
  return lines.length ? lines : null
}

const clientKey = request => request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown'

export async function handleCspReport(request, { limiter, log = console.error } = {}) {
  if (!limiter(clientKey(request))) return new Response(null, { status: 429 })
  const text = await readLimitedText(request)
  if (text === null) return new Response(null, { status: 413 })
  const lines = summarizeCspReport(text)
  if (!lines) return new Response(null, { status: 400 })
  for (const line of lines) log(line)
  return new Response(null, { status: 204 })
}
