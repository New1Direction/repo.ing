import pg from 'pg'
export const MARKET_CHANNEL = 'repoing_market_updates'
// Stock-paired markets' hints (migration 0054): a new stock trade or fee row. Either changes what a chart or an activity
// read shows, so both reach listeners as 'trade', the kind the SOL channel uses for the same thing.
export const STOCK_MARKET_CHANNEL = 'repoing_stock_market_updates'
export function parseMarketNotification(payload, channel = MARKET_CHANNEL) {
  try {
    const value = JSON.parse(payload)
    if (channel === STOCK_MARKET_CHANNEL) {
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.mint) && ['trade', 'fee'].includes(value.kind) ? { mint: value.mint, kind: 'trade' } : null
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.mint) || !['trade','curve'].includes(value.kind)) return null
    return { mint: value.mint, kind: value.kind }
  } catch { return null }
}

// One dedicated LISTEN connection per web process, never one per browser.
// Notifications are disposable hints; reconnects request a canonical resync.
export function createMarketNotifications({ connectionString, makeClient = options => new pg.Client(options), retryMs = 3000, idleMs = 30000 } = {}) {
  const listeners = new Map()
  let client = null, connecting = null, retry = null, idle = null, count = 0, closed = false
  function emit(mint, kind) {
    for (const fn of listeners.get(mint) ?? []) { try { fn({ mint, kind }) } catch { /* An ended stream cannot affect other viewers. */ } }
  }
  function disconnect() {
    const previous = client; client = null
    if (previous) void previous.end().catch(() => {})
  }
  async function connect() {
    if (closed || !count || client || connecting) return
    const next = makeClient({ connectionString, connectionTimeoutMillis: 5000, keepAlive: true, application_name: 'repoing_market_updates' })
    client = next
    const failed = () => {
      if (client !== next) return
      disconnect()
      if (!closed && count && !retry) retry = setTimeout(() => { retry = null; void connect() }, retryMs)
    }
    next.on('error', failed)
    next.on('end', failed)
    next.on('notification', message => {
      if (client !== next || (message.channel !== MARKET_CHANNEL && message.channel !== STOCK_MARKET_CHANNEL)) return
      const value = parseMarketNotification(message.payload, message.channel)
      if (value) emit(value.mint, value.kind)
    })
    connecting = (async () => {
      try {
        await next.connect()
        await next.query(`LISTEN ${MARKET_CHANNEL}`)
        await next.query(`LISTEN ${STOCK_MARKET_CHANNEL}`)
        if (client === next) for (const mint of listeners.keys()) emit(mint, 'resync')
      } catch { failed() }
    })()
    try { await connecting } finally {
      connecting = null
      if (!client && !closed && count && !retry) retry = setTimeout(() => { retry = null; void connect() }, retryMs)
    }
  }
  function subscribe(mint, fn) {
    if (closed || count >= 500) throw Error('Live updates temporarily unavailable')
    clearTimeout(idle)
    const callbacks = listeners.get(mint) ?? new Set()
    callbacks.add(fn); listeners.set(mint, callbacks); count++
    void connect()
    let removed = false
    return () => {
      if (removed) return
      removed = true; callbacks.delete(fn); count--
      if (!callbacks.size) listeners.delete(mint)
      if (!count) {
        clearTimeout(retry); retry = null
        idle = setTimeout(disconnect, idleMs)
      }
    }
  }
  function close() { closed = true; clearTimeout(retry); clearTimeout(idle); disconnect(); listeners.clear() }
  return { subscribe, close }
}
