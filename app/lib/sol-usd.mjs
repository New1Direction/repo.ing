import { timed } from './server-timing.mjs'

let cachedPrice = null
let expiresAt = 0
let pending = null
let retryAt = 0

const CACHE_MS = 5 * 60 * 1000
// In the last minute of a valid price, the next request starts the refresh in the background and still gets the valid
// price, so under steady traffic no page waits on the price sources (and a price is never served past its expiry).
const REFRESH_AHEAD_MS = 60 * 1000
const FAILURE_BACKOFF_MS = 30 * 1000
// CoinGecko rate-limits shared hosting IPs, so fall through to independent USD sources in order.
const SOURCES = [
  ['https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', body => body?.solana?.usd],
  ['https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', body => body?.So11111111111111111111111111111111111111112?.usdPrice],
  ['https://api.coinbase.com/v2/prices/SOL-USD/spot', body => Number(body?.data?.amount)],
]

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

async function readSource(fetchImpl, url, pick) {
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2500) })
    if (!response.ok) return null
    const price = pick(await response.json())
    return Number.isFinite(price) && price > 0 ? price : null
  } catch { return null }
}

async function loadPrice(fetchImpl, now) {
  for (const [url, pick] of SOURCES) {
    const price = await readSource(fetchImpl, url, pick)
    if (price === null) continue
    cachedPrice = price
    expiresAt = now + CACHE_MS
    return price
  }
  // Never serve an expired price; back off briefly so every page view doesn't re-hit failing sources.
  retryAt = now + FAILURE_BACKOFF_MS
  return null
}
