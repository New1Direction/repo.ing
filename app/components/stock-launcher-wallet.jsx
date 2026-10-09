import { formatTokenAmount, formatUnits, formatUsdValue } from '../lib/format.mjs'
import { chartPriceLabel } from '../lib/chart-display.mjs'
import { stockAmountLabel, stockDisplayUnits, stockRawUsd } from '../lib/stock-display.mjs'
import styles from './stock-pair.module.css'

// /wallet: launcher earnings on stock-paired markets, in the stock (src/stock-launcher-earnings.mjs). The launcher earns 0.30%
// of every trade, forever; it is collected into custody with the market's fees and paid out to the launcher wallet from there.
// Amounts are shown as wallets show the stock (raw × its ScaledUiAmount multiplier); without the multiplier they are withheld
// rather than shown in raw units.
const amount = (shown, asset) => shown == null ? '—' : `${formatTokenAmount(shown, asset.decimals)} ${asset.symbol}`
const exact = (shown, asset) => shown == null ? undefined : `${formatUnits(shown, asset.decimals)} ${asset.symbol}`

// Summary tile: totals per stock across the markets this wallet launched.
export function StockLauncherTile({ stockLauncher }) {
  if (stockLauncher === undefined) return null
  if (stockLauncher === null) return <div className="inner-card"><span>Launcher earnings in stocks</span><strong>—</strong><small>Temporarily unavailable.</small></div>
  if (!stockLauncher.totals.length) return null
  return <div className="inner-card wallet-stock-launcher"><span>Launcher earnings in stocks</span>
    {stockLauncher.totals.map(total => <div key={total.asset.assetId} className={styles.total}>
      <strong title={exact(total.shown?.earned, total.asset)}>{amount(total.shown?.earned, total.asset)}</strong>
      <small>{total.shown ? `${amount(total.shown.payable, total.asset)} awaiting payout · ${amount(total.shown.paid, total.asset)} paid · ${amount(total.shown.uncollected, total.asset)} not yet collected`
        : `${total.asset.symbol} display units are unavailable right now.`} · {total.markets} {total.markets === 1 ? 'market' : 'markets'}</small>
    </div>)}
  </div>
}

// One launched stock-paired market's row value.
export function StockLauncherValue({ earnings }) {
  if (!earnings) return <span className="muted">Launcher earnings unavailable</span>
  if (earnings.review) return <span className="muted">Launcher balance under review</span>
  const { asset, shown } = earnings
  return <span className={shown && BigInt(shown.payable) > 0n ? 'wallet-launcher-claimable' : ''}>You earn 0.30% as launcher
    <strong title={exact(shown?.earned, asset)}>{amount(shown?.earned, asset)} earned</strong>
    <small>{shown ? `${amount(shown.payable, asset)} awaiting payout · ${amount(shown.paid, asset)} paid${BigInt(shown.pending) > 0n ? ` · ${amount(shown.pending, asset)} being sent` : ''}` : 'Display units unavailable'}</small></span>
}

// A held stock pair's value (the wallet API's row.stockValue, app/lib/portfolio.mjs stockHoldingValue), in the slot where a SOL
// market's row shows its SOL value: in the stock as wallets show it, with USD at the stock's own price, never in SOL. Without
// the stock's display units the amount is withheld ('—') rather than shown in raw units, as on every stock surface.
export function StockHoldingValue({ value }) {
  const units = value && !value.unavailable ? stockDisplayUnits(value) : null
  return <span className="wallet-market-value">Value<strong>{units && value.valueRaw !== null ? stockAmountLabel(value.valueRaw, units) : '—'}</strong>
    <small>{stockValueNote(value, units)}</small></span>
}

function stockValueNote(value, units) {
  if (!value || value.unavailable) return `Not valued here: ${value?.symbol ?? 'stock'} prices are unavailable right now`
  if (value.valueRaw === null) return `Not valued yet: no ${value.symbol} trade price`
  if (!units) return `${value.symbol} display units are unavailable right now`
  const usd = formatUsdValue(stockRawUsd(value.valueRaw, units))
  return `${usd ? `≈ ${usd} · ` : ''}${chartPriceLabel(value.price * units.multiplier)} ${value.symbol} each`
}
