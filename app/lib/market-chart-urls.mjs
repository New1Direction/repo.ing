// One spelling for the chart's data URLs: the token page preloads exactly these, and a preload is only reused by a
// fetch() of the identical URL (with the same credentials and cache mode). fresh: a refetch prompted by a live trade
// hint; the API answers it uncached so an edge copy from just before the trade is never shown.
export const marketTradesUrl = (mint, range = 'all', { fresh = false } = {}) => `/api/market/${encodeURIComponent(mint)}/trades?range=${range}${fresh ? '&fresh=1' : ''}`
export const marketMetricsUrl = mint => `/api/market/${encodeURIComponent(mint)}/metrics`
export const marketCurveUrl = (mint, { fresh = false } = {}) => `/api/market/${encodeURIComponent(mint)}/curve${fresh ? '?fresh=1' : ''}`
