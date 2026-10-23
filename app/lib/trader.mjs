import { createCanonicalTrader } from '../../src/canonical-trade.mjs'
import { createDammTrader, createTradeRouter } from '../../src/canonical-damm-trade.mjs'
import { chain, configAddress } from './server.mjs'
import { tradingCustodyRecovery, tradingDatabase as database, tradingMarketLoader } from './trading-recovery.mjs'

// One process-wide router shared by the site trade API and Solana Actions: repo ID -> curve or graduated trader.
export function tradeRouter() {
  const custodyRecovery = tradingCustodyRecovery()
  const custodyDigest = process.env.TRADING_CUSTODY_RECOVERY_SHA256
  const pool = database(), config = configAddress()
  if (!pool || !config) throw new Error('Trading is not configured')
  const loadMarket = tradingMarketLoader(pool, config, custodyRecovery)
  if (!globalThis.__gitfunTrader || globalThis.__gitfunTraderConfig !== config || globalThis.__gitfunTraderCustodyDigest !== custodyDigest) {
    const connection = chain()
    globalThis.__gitfunTrader = createTradeRouter({ curve: createCanonicalTrader({ pool, connection, config, loadMarket }),
      graduated: createDammTrader({ pool, connection, config, custodyRecovery, loadMarket }) })
    globalThis.__gitfunTraderConfig = config
    globalThis.__gitfunTraderCustodyDigest = custodyDigest
  }
  return globalThis.__gitfunTrader
}
