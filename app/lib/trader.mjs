import { createCanonicalTrader } from '../../src/canonical-trade.mjs'
import { createDammTrader, createTradeRouter } from '../../src/canonical-damm-trade.mjs'
import { database, chain, configAddress } from './server.mjs'

// One process-wide router shared by the site trade API and Solana Actions: repo ID -> curve or graduated trader.
export function tradeRouter() {
  const pool = database(), config = configAddress()
  if (!pool || !config) throw new Error('Trading is not configured')
  if (!globalThis.__gitfunTrader || globalThis.__gitfunTraderConfig !== config) {
    const connection = chain()
    globalThis.__gitfunTrader = createTradeRouter({ curve: createCanonicalTrader({ pool, connection, config }),
      graduated: createDammTrader({ pool, connection, config }) })
    globalThis.__gitfunTraderConfig = config
  }
  return globalThis.__gitfunTrader
}
