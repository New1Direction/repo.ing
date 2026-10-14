// Aggregate UI events only: no market, wallet, repository, URL, referrer, session or user identifier.
export const MARKET_EVENTS = Object.freeze(['view', 'watch', 'unwatch', 'evidence', 'history', 'risks', 'trade_intent', 'availability'])
export const MARKET_PAGES = Object.freeze(['token', 'schedule'])
export function parseMarketEvent(text) {
  if (typeof text !== 'string' || text.length > 128) throw Error('INVALID_MARKET_EVENT')
  const body = JSON.parse(text)
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['event', 'page'].includes(key)) ||
      !MARKET_EVENTS.includes(body.event) || !MARKET_PAGES.includes(body.page)) throw Error('INVALID_MARKET_EVENT')
  return { event: body.event, page: body.page }
}

export function sendMarketEvent(event, page, { navigator: nav = globalThis.navigator, fetch: send = globalThis.fetch } = {}) {
  if (!nav || nav.globalPrivacyControl || nav.doNotTrack === '1') return
  try {
    const body = JSON.stringify(parseMarketEvent(JSON.stringify({ event, page })))
    // Unlike sendBeacon, fetch lets us explicitly omit credentials and the page's referrer.
    void send('/api/market-events', { method: 'POST', body, credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true }).catch(() => {})
  } catch { /* Measurement never affects the page. */ }
}
