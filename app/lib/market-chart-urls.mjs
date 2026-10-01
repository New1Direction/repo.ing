// One spelling for the chart's data URLs: the token page preloads exactly these, and a preload is only reused by a
// fetch() of the identical URL (with the same credentials and cache mode).
export const marketTradesUrl = (mint, range = 'all') => `/api/market/${encodeURIComponent(mint)}/trades?range=${range}`
export const marketMetricsUrl = mint => `/api/market/${encodeURIComponent(mint)}/metrics`
