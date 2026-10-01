import { AsyncLocalStorage } from 'node:async_hooks'

// Server data-loader timing. timed(label, fn) measures one loader. A slow one (over SLOW_LOADER_MS) writes ONE compact
// JSON line, at most once per label per LOG_WINDOW_MS; the line counts the slow calls folded since the previous one, so
// logs stay bounded under load while still showing how often a loader is slow. Inside an API route wrapped with
// withServerTiming, every timed loader also lands in that response's Server-Timing header (browser devtools show it).
// Labels are code-defined loader names, never user input. SERVER_TIMING_SLOW_MS lowers the threshold while diagnosing.
const configuredSlowMs = process.env.SERVER_TIMING_SLOW_MS ? Number(process.env.SERVER_TIMING_SLOW_MS) : NaN
export const SLOW_LOADER_MS = Number.isFinite(configuredSlowMs) && configuredSlowMs >= 0 ? configuredSlowMs : 150
export const LOG_WINDOW_MS = 60_000
const MAX_TIMING_ENTRIES = 20

// Server-Timing metric names are HTTP tokens; this only guards the header.
export const timingName = label => String(label).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'loader'

export function createSlowLog({ thresholdMs = SLOW_LOADER_MS, windowMs = LOG_WINDOW_MS, now = Date.now, write = line => console.log(line) } = {}) {
  const windows = new Map()
  return function record(label, ms) {
    if (!(ms > thresholdMs)) return false
    const at = now(), seen = windows.get(label)
    if (seen && at < seen.until) { seen.folded++; seen.maxMs = Math.max(seen.maxMs, ms); return false }
    const folded = seen?.folded ? { foldedSlow: seen.folded, foldedMaxMs: Math.round(seen.maxMs) } : {}
    write(JSON.stringify({ slowLoader: { label, ms: Math.round(ms), ...folded } }))
    windows.set(label, { until: at + windowMs, folded: 0, maxMs: 0 })
    return true
  }
}

// Route handlers and pages can load separate module copies; one request store and one log window per process.
const shared = globalThis.__repoingServerTiming ??= { requests: new AsyncLocalStorage(), slowLog: createSlowLog() }

export async function timed(label, fn, { log = shared.slowLog, clock = () => performance.now() } = {}) {
  const start = clock()
  try { return await fn() }
  finally {
    const ms = clock() - start
    const entries = shared.requests.getStore()
    if (entries && entries.length < MAX_TIMING_ENTRIES) entries.push({ name: timingName(label), ms })
    log(label, ms)
  }
}

export function serverTimingHeader(entries, totalMs) {
  return [...entries, ...(Number.isFinite(totalMs) ? [{ name: 'total', ms: totalMs }] : [])]
    .map(({ name, ms }) => `${name};dur=${Math.max(0, ms).toFixed(1)}`).join(', ')
}

// Route handler wrapper: collects the timed loaders of this request into a Server-Timing header.
export function withServerTiming(handler, { clock = () => performance.now() } = {}) {
  return async (...args) => {
    const entries = [], start = clock()
    const response = await shared.requests.run(entries, () => handler(...args))
    try { response.headers.set('Server-Timing', serverTimingHeader(entries, clock() - start)) } catch { /* Immutable headers: skip. */ }
    return response
  }
}
