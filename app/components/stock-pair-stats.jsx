import { chain, database } from '../lib/server.mjs'
import { readStockAnalytics } from '../../src/stock-analytics.mjs'
import { quoteAssetInfo } from '../../src/quote-asset-info.mjs'
import { formatUsdValue } from '../lib/format.mjs'
import { stockAmountLabel, stockDisplayUnits, stockRawUsd } from '../lib/stock-display.mjs'

const PERIOD = { '24h': 'Past 24 hours', '7d': 'Past 7 days', '30d': 'Past 30 days', all: 'All time' }
const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

// Today's display facts of a registry stock (multiplier and USD price), or null when they cannot be read.
async function unitsOf(asset) {
  if (!asset.symbol) return null
  try { return stockDisplayUnits(await quoteAssetInfo(asset.assetId, { connection: chain() })) } catch { return null }
}

// One figure in its stock as wallets show it, with a USD estimate at that stock's price under it.
function StockAmount({ raw, units }) {
  const usd = formatUsdValue(stockRawUsd(raw, units))
  return <>{stockAmountLabel(raw, units)}{usd && <small>≈ {usd}</small>}</>
}

// /stats: stock-paired markets, per stock (src/stock-analytics.mjs), for the selected period. Shown only once a stock pair has
// traded or earned a fee. Each stock keeps its own figures: none is added to the SOL figures above (which count SOL markets
// only) or to another stock.
export async function StockPairStats({ range = 'all' }) {
  const db = database()
  if (!db) return null
  let data
  try { data = await readStockAnalytics(db, { range }) }
  catch (error) { console.error('stock pair totals unavailable', error?.code ?? error?.message ?? 'error'); return null }
  if (!data.hasActivity) return null
  const units = new Map(await Promise.all(data.assets.map(async asset => [asset.assetId, await unitsOf(asset)])))
  const missing = data.assets.some(asset => !units.get(asset.assetId))
  return <section className="analytics-token tip-stats" aria-labelledby="stock-pairs-title"><div>
    <div className="eyebrow">STOCK PAIRS</div><h2 id="stock-pairs-title">Stock-paired markets</h2>
    <p>Markets paired with a tokenized stock trade and pay fees in that stock, so each stock is counted on its own here and none of it is in the SOL figures above. Of every trading fee, the launcher’s share goes to the market’s launcher and the rest is credited to that stock’s accumulator, for permanent liquidity.</p>
    <div className="operations-table-wrap tip-stats-table"><table><thead><tr><th>Stock</th><th>Volume</th><th>Trading fees</th><th>To launchers</th><th>To the accumulator</th></tr></thead><tbody>
      {data.assets.map(asset => { const shown = units.get(asset.assetId)
        return <tr key={`${asset.assetId}:${asset.mint}`}><td><strong>{asset.symbol ?? asset.assetId}</strong><small>{`${count(asset.markets, 'market', 'markets')} · ${count(asset.trades, 'trade', 'trades')}`}</small></td>
          {['volume', 'fees', 'launcher', 'accumulator'].map(field => <td key={field}><StockAmount raw={asset[field]} units={shown}/></td>)}</tr> })}
    </tbody></table></div>
    <p className="analytics-note">{`${PERIOD[data.range]} · trades use chain time and fees indexing time. Amounts are shown as wallets show each stock, at today’s display multiplier; USD estimates use today’s price.${missing ? ' A stock whose units cannot be read right now shows —.' : ''}`}</p>
  </div></section>
}
