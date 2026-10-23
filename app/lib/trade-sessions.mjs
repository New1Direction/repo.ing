import { createTradeSessionStore } from '../../src/trade-sessions.mjs'
import { tradingDatabase as database } from './trading-recovery.mjs'
import { tradeRouter } from './trader.mjs'

// One store per process; its Map is only a cache in front of the trade_sessions table.
export function tradeSessions() {
  const router = tradeRouter()
  if (!globalThis.__gitfunTradeSessions || globalThis.__gitfunTradeSessionsRouter !== router) {
    globalThis.__gitfunTradeSessions = createTradeSessionStore({ db: database(), engineFor: router.forPhase,
      requirePersistence: process.env.EXISTING_MARKET_TRADING_ONLY === 'true',
      allowRebroadcast: process.env.EXISTING_MARKET_TRADING_ONLY !== 'true' })
    globalThis.__gitfunTradeSessionsRouter = router
  }
  return globalThis.__gitfunTradeSessions
}
