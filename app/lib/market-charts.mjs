import { database, marketByMint } from './server.mjs'
import { readMarketChart } from '../../src/market-chart.mjs'
import { createChartCache } from './chart-cache.mjs'
import { marketNotificationHub } from './market-hub.mjs'
import { timed } from './server-timing.mjs'

// Built chart payloads (src/market-chart.mjs, serialized) per market and range, for /api/market/<mint>/trades and the home
// page's live $REPOING card: one cache per web process, so the home page reads the same series the API serves and is
// invalidated by the same trade notifications.
export function marketCharts() {
  return globalThis.__repoingChartCache ??= createChartCache({
    async load(mint, range) {
      const { market, unavailable } = await marketByMint(mint)
      if (unavailable) throw Error(unavailable)
      if (!market) return null
      return JSON.stringify(await timed('chart', () => readMarketChart(database(), market, range)))
    },
    subscribe(mint, onChange) {
      const hub = marketNotificationHub()
      return hub ? hub.subscribe(mint, ({ kind }) => { if (kind !== 'curve') onChange() }) : null
    },
  })
}
