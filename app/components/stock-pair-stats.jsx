import { chain, database } from '../lib/server.mjs'
import { readStockAnalytics } from '../../src/stock-analytics.mjs'
import { quoteAssetInfo } from '../../src/quote-asset-info.mjs'
import { StockPairTable, unitsKey } from './stock-pair-table'
import { stockDisplayUnits } from '../lib/stock-display.mjs'
import { unitsWithin } from '../lib/stock-market-stats.mjs'

// Today's display facts of a registry stock (multiplier and USD price), or null when they cannot be read in time. A row
// whose stamped mint is not the registry's (symbol null) is never converted.
async function unitsOf(asset) {
  if (!asset.symbol) return null
  return stockDisplayUnits(await unitsWithin(() => quoteAssetInfo(asset.assetId, { connection: chain() }), asset.assetId))
}

// /stats: stock-paired markets, per stock (src/stock-analytics.mjs), for the selected period. Renders nothing until a stock
// pair has traded or earned a fee, and nothing when the totals cannot be read (logged): the SOL figures never wait on it.
export async function StockPairStats({ range = 'all' }) {
  const db = database()
  if (!db) return null
  let data
  try { data = await readStockAnalytics(db, { range }) }
  catch (error) { console.error('stock pair totals unavailable', error?.code ?? error?.message ?? 'error'); return null }
  if (!data.hasActivity) return null
  const units = Object.fromEntries(await Promise.all(data.assets.map(async asset => [unitsKey(asset), await unitsOf(asset)])))
  return <StockPairTable data={data} units={units}/>
}
