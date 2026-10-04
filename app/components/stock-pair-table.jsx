import { formatUsdValue } from '../lib/format.mjs'
import { stockAmountLabel, stockRawUsd } from '../lib/stock-display.mjs'

const PERIOD = { '24h': 'Past 24 hours', '7d': 'Past 7 days', '30d': 'Past 30 days', all: 'All time' }
// Units belong to one asset row, (asset id, stamped mint), so a row is never converted with another row's units.
export const unitsKey = asset => `${asset.assetId}:${asset.mint}`
const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

// The stock section when its totals cannot be read: said so, as the SOL analytics say it, never hidden.
export function StockPairsUnavailable() {
  return <div className="state-card error" role="status">Stock-pair totals are temporarily unavailable. Please try again shortly.</div>
}

// One figure in its stock as wallets show it, with a USD estimate at that stock's price under it.
function StockAmount({ raw, units }) {
  const usd = formatUsdValue(stockRawUsd(raw, units))
  return <>{stockAmountLabel(raw, units)}{usd && <small>≈ {usd}</small>}</>
}

// The /stats stock section (StockPairStats reads it): per stock, its volume, trading fees and their split, each in that
// stock (never added to SOL or to another stock). data: readStockAnalytics; units: unitsKey(asset) → stockDisplayUnits or null.
export function StockPairTable({ data, units = {} }) {
  const missing = data.assets.some(asset => !units[unitsKey(asset)])
  return <section className="analytics-token tip-stats" aria-labelledby="stock-pairs-title"><div>
    <div className="eyebrow">STOCK PAIRS</div><h2 id="stock-pairs-title">Stock-paired markets</h2>
    <p>Markets paired with a tokenized stock trade and pay fees in that stock, so each stock is counted on its own here and none of it is in the SOL figures above. Of every trading fee, the launcher’s share goes to the market’s launcher and the rest is credited to that stock’s accumulator, for permanent liquidity.</p>
    <div className="operations-table-wrap tip-stats-table"><table><thead><tr><th>Stock</th><th>Volume</th><th>Fees</th><th>Launchers</th><th>Accumulator</th></tr></thead><tbody>
      {data.assets.map(asset => <tr key={unitsKey(asset)}><td><strong>{asset.symbol ?? asset.assetId}</strong><small>{`${count(asset.markets, 'market', 'markets')} · ${count(asset.trades, 'trade', 'trades')}`}</small></td>
        {['volume', 'fees', 'launcher', 'accumulator'].map(field => <td key={field}><StockAmount raw={asset[field]} units={units[unitsKey(asset)] ?? null}/></td>)}</tr>)}
    </tbody></table></div>
    <p className="analytics-note">{`${PERIOD[data.range] ?? PERIOD.all} · trades use chain time and fees indexing time. Amounts are shown as wallets show each stock, at today’s display multiplier; USD estimates use today’s price.${missing ? ' A stock whose units cannot be read right now shows —.' : ''}`}</p>
  </div></section>
}
