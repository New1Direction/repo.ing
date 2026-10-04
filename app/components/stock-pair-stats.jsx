import { chain } from '../lib/server.mjs'
import { stockPairTotals } from '../lib/stock-pair-totals.mjs'
import { stockUnits } from '../lib/stock-units.mjs'
import { StockPairTable, StockPairsUnavailable, unitsKey } from './stock-pair-table'
import { stockDisplayUnits } from '../lib/stock-display.mjs'

// Today's display facts of a registry stock (the units cache: at most UNITS_WAIT_MS when nothing is cached), or null. A row
// whose stamped mint is not the registry's (symbol null) is never converted.
async function unitsOf(asset) {
  if (!asset.symbol) return null
  return stockDisplayUnits(await stockUnits.within(asset.assetId, chain))
}

// /stats: stock-paired markets, per stock, for the selected period. Nothing before any stock pair has traded or earned a fee
// (or without a database); a failed read shows as unavailable, never as no stock activity.
export async function StockPairStats({ range = 'all' }) {
  let data
  try { data = await stockPairTotals(range) }
  catch (error) { console.error('stock pair totals unavailable', error?.code ?? error?.message ?? 'error'); return <StockPairsUnavailable/> }
  if (!data?.hasActivity) return null
  const units = Object.fromEntries(await Promise.all(data.assets.map(async asset => [unitsKey(asset), await unitsOf(asset)])))
  return <StockPairTable data={data} units={units}/>
}
