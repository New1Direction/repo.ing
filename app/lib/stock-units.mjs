import { quoteAssetInfo } from '../../src/quote-asset-info.mjs'

// A stock's display facts on the server (src/quote-asset-info.mjs: the ScaledUiAmount multiplier in force, how long it holds,
// the USD price), for the market list, /stats, the metrics route and the activity feed. One small cache per process, per
// asset, refreshed in the background: a render never waits on the RPC beyond UNITS_WAIT_MS, and the shared market list never
// waits at all. Units are served only while they hold (their validForSeconds, at most 120 s, never past a multiplier change
// the issuer scheduled); after that, until a refresh succeeds, there are none (null), and pages show "—", never a stale
// multiplier.
export const UNITS_WAIT_MS = 1_500
const REFRESH_MS = 30_000
const TIMED_OUT = Symbol('timed out')

// `read` within `ms`, else null; a failure or a timeout is logged under `label`.
export async function unitsWithin(read, label, ms = UNITS_WAIT_MS) {
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })
  try {
    const value = await Promise.race([Promise.resolve().then(read), late])
    if (value === TIMED_OUT) { console.error('stock units unavailable', label, 'timeout'); return null }
    return value ?? null
  } catch (error) { console.error('stock units unavailable', label, error?.code ?? error?.message ?? 'error'); return null }
  finally { clearTimeout(timer) }
}

// connection: a Connection or a function making one (made only for a refresh, so a cached answer needs no RPC).
export function createStockUnitsCache({ info = quoteAssetInfo, now = Date.now, waitMs = UNITS_WAIT_MS, refreshMs = REFRESH_MS } = {}) {
  const entries = new Map()
  function refresh(assetId, connection) {
    const entry = entries.get(assetId)
    if (entry?.pending) return entry.pending
    const started = now()
    const pending = unitsWithin(() => info(assetId, { connection: typeof connection === 'function' ? connection() : connection }), assetId, waitMs)
      .then(value => {
        const held = Number.isFinite(value?.validForSeconds) && value.validForSeconds > 0
        // A failed refresh keeps the last units only for as long as they hold.
        entries.set(assetId, held ? { value, until: started + value.validForSeconds * 1000, at: started } : { ...entries.get(assetId), pending: null, at: started })
        return held ? value : null
      })
    entries.set(assetId, { ...entry, pending })
    return pending
  }
  const usable = (entry, at) => entry?.value && at < entry.until
    ? { ...entry.value, validForSeconds: Math.max(1, Math.ceil((entry.until - at) / 1000)) } : null
  // The units in force now, or null. Starts a background refresh when they are missing, lapsed or older than refreshMs;
  // never waits for it.
  function current(assetId, connection) {
    const entry = entries.get(assetId), at = now()
    if (!entry?.pending && (!usable(entry, at) || at - entry.at >= refreshMs)) refresh(assetId, connection)
    return usable(entry, at)
  }
  // As current(), but with nothing usable cached it waits for the refresh (at most waitMs).
  async function within(assetId, connection) {
    const cached = current(assetId, connection)
    if (cached) return cached
    await entries.get(assetId)?.pending
    return usable(entries.get(assetId), now())
  }
  return { current, within, clear: () => entries.clear() }
}

export const stockUnits = globalThis.__repoingStockUnits ??= createStockUnitsCache()
