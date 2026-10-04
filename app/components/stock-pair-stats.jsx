import { chain, database } from '../lib/server.mjs'
import { readStockAnalytics } from '../../src/stock-analytics.mjs'
import { quoteAssetInfo } from '../../src/quote-asset-info.mjs'
import { StockPairTable } from './stock-pair-table'
import { stockDisplayUnits } from '../lib/stock-display.mjs'

// Today's display facts of a registry stock (multiplier and USD price), or null when they cannot be read.
async function unitsOf(asset) {
  if (!asset.symbol) return null
  try { return stockDisplayUnits(await quoteAssetInfo(asset.assetId, { connection: chain() })) } catch { return null }
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
  const units = Object.fromEntries(await Promise.all(data.assets.map(async asset => [asset.assetId, await unitsOf(asset)])))
  return <StockPairTable data={data} units={units}/>
}
