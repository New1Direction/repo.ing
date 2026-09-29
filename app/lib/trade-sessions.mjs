import { createTradeSessionStore } from '../../src/trade-sessions.mjs'
import { database } from './server.mjs'
import { tradeRouter } from './trader.mjs'

// One store per process; its Map is only a cache in front of the trade_sessions table.
export function tradeSessions() {
  const router = tradeRouter()
  if (!globalThis.__gitfunTradeSessions || globalThis.__gitfunTradeSessionsRouter !== router) {
    globalThis.__gitfunTradeSessions = createTradeSessionStore({ db: database(), engineFor: router.forPhase })
    globalThis.__gitfunTradeSessionsRouter = router
  }
  return globalThis.__gitfunTradeSessions
}
