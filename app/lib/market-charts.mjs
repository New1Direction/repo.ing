import { database, marketByMint } from './server.mjs'
import { readMarketChart } from '../../src/market-chart.mjs'
import { isStockMarket, readStockMarketChart } from '../../src/stock-market-chart.mjs'
import { createChartCache } from './chart-cache.mjs'
import { marketNotificationHub } from './market-hub.mjs'
import { timed } from './server-timing.mjs'

// A market's chart reader, by its quote: a stock-paired market reads the stock ledger (src/stock-market-chart.mjs); every
// other market reads the SOL chart, which marketCharts below asks for with its live trades.
export const chartReader = market => isStockMarket(market) ? readStockMarketChart : readMarketChart

// Built chart payloads (src/market-chart.mjs, serialized) per market and range, for /api/market/<mint>/trades and the home
// page's live $REPOING card: one cache per web process, so the home page reads the same series the API serves and is
// invalidated by the same trade notifications.
export function marketCharts() {
  return globalThis.__repoingChartCache ??= createChartCache({
    async load(mint, range) {
      const { market, unavailable } = await marketByMint(mint)
      if (unavailable) throw Error(unavailable)
      if (!market) return null
      const read = chartReader(market)
      // live: a SOL chart also shows confirmed trades the finalized ledgers do not hold yet (src/market-chart.mjs
      // mergeLiveTrades); the stock reader takes no options.
      return JSON.stringify(await timed('chart', () => read(database(), market, range, Date.now(), { live: true })))
    },
    subscribe(mint, onChange) {
      const hub = marketNotificationHub()
      return hub ? hub.subscribe(mint, ({ kind }) => { if (kind !== 'curve') onChange() }) : null
    },
  })
}
