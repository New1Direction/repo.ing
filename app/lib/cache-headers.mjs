// Cache headers for public GET APIs whose body depends only on the URL (never on cookies, wallets or other headers).
// Browsers keep refetching (max-age=0, no stale-while-revalidate, so a chart never paints an old copy); a shared cache may
// keep a copy for edgeSeconds (s-maxage). Cloudflare disables stale-while-revalidate whenever s-maxage is present, so the
// CDN's own window travels in CDN-Cache-Control (RFC 9213): Cloudflare reads it ahead of Cache-Control, browsers ignore it.
// JSON is not cached by Cloudflare unless a Cache Rule marks these paths eligible (docs/PRODUCTION.md).
export const NO_STORE = Object.freeze({ 'Cache-Control': 'no-store' })

export function publicCacheHeaders(edgeSeconds, staleSeconds = 0) {
  if (!Number.isInteger(edgeSeconds) || edgeSeconds < 1 || !Number.isInteger(staleSeconds) || staleSeconds < 0) throw Error('Invalid cache lifetime')
  return Object.freeze({ 'Cache-Control': `public, max-age=0, s-maxage=${edgeSeconds}`,
    'CDN-Cache-Control': `max-age=${edgeSeconds}${staleSeconds ? `, stale-while-revalidate=${staleSeconds}` : ''}` })
}

// Live market data refetched right after an SSE trade/curve hint asks for ?fresh=1 and is never served from the edge;
// page loads, hover prefetches and fallback polling share the short edge copy.
export const MARKET_TRADES_CACHE = publicCacheHeaders(2)
export const MARKET_CURVE_CACHE = publicCacheHeaders(2)
export const MARKET_ACTIVITY_CACHE = publicCacheHeaders(5)
// Holder count and supply: polled every 30 s and stale after 75 s on the client; the RPC read behind it is cached longer.
export const MARKET_METRICS_CACHE = publicCacheHeaders(10, 20)
// Trend candidates and Explore highlights: rebuilt at most every 15 s per process anyway.
export const REPO_SEARCH_CACHE = publicCacheHeaders(15, 45)
export const GROWTH_CACHE = publicCacheHeaders(15, 45)
// Dev Pulse: the worker refreshes GitHub activity every 10–30 minutes per repository; the page polls every 2 minutes.
export const PULSE_CACHE = publicCacheHeaders(30, 60)

export const wantsFresh = request => new URL(request.url).searchParams.has('fresh')
export const marketCacheHeaders = (request, headers) => wantsFresh(request) ? NO_STORE : headers
