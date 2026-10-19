import { timed } from './server-timing.mjs'
import { SOL_USD_SOURCES, readSolUsdSource } from '../../src/sol-usd-sources.mjs'

let cachedPrice = null
let expiresAt = 0
let pending = null
let retryAt = 0

const CACHE_MS = 5 * 60 * 1000
// In the last minute of a valid price, the next request starts the refresh in the background and still gets the valid
// price, so under steady traffic no page waits on the price sources (and a price is never served past its expiry).
const REFRESH_AHEAD_MS = 60 * 1000
const FAILURE_BACKOFF_MS = 30 * 1000

export async function solUsdPrice(fetchImpl = fetch, now = Date.now()) {
  if (cachedPrice !== null && now < expiresAt) {
    if (now >= expiresAt - REFRESH_AHEAD_MS && now >= retryAt && !pending) refresh(fetchImpl, now).catch(() => {})
    return cachedPrice
  }
  if (now < retryAt) return null
  if (pending) return pending
  return refresh(fetchImpl, now)
}

// The cached price without waiting (null when there is none): for markup that must not hold up the page on the price sources.
// A missing or ending price starts its refresh, so later requests find it.
export function cachedSolUsdPrice(fetchImpl = fetch, now = Date.now()) {
  solUsdPrice(fetchImpl, now).catch(() => {})
  return cachedPrice !== null && now < expiresAt ? cachedPrice : null
}

function refresh(fetchImpl, now) {
  pending = timed('solUsdPrice', () => loadPrice(fetchImpl, now)).finally(() => { pending = null })
  return pending
}

async function loadPrice(fetchImpl, now) {
  // CoinGecko rate-limits shared hosting IPs, so fall through to independent USD sources in order.
  for (const [, url, pick] of SOL_USD_SOURCES) {
    const price = await readSolUsdSource(fetchImpl, url, pick)
    if (price === null) continue
    cachedPrice = price
    expiresAt = now + CACHE_MS
    return price
  }
  // Never serve an expired price; back off briefly so every page view doesn't re-hit failing sources.
  retryAt = now + FAILURE_BACKOFF_MS
  return null
}
