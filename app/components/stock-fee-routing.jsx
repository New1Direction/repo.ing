import { XHandleLink, hasXHandle } from './x-handle-link'
import { xHandleFor } from '../lib/x-links.mjs'
import { shortWallet } from '../lib/holder-note-format.mjs'
import { formatTokenAmount, formatUnits } from '../lib/format.mjs'
import { STOCK_FEE_SPLIT, stockFeeRouting } from '../lib/stock-fee-routing.mjs'
import { STOCK_PAIR_NO_OWNER_CLAIM } from '../../src/stock-owner-claims.mjs'
import styles from './stock-pair.module.css'

// Token page of a stock-paired market (docs/STOCK_QUOTES.md, "Fee policy"): where every trade's fee goes, in place of the
// builder claim link and the owner invitation. There is no owner claim on a stock pair (STOCK_PAIR_NO_OWNER_CLAIM): the
// launcher earns 0.30% in the stock, forever, and the builder share and repo.ing's share become permanent $REPOING / <stock>
// liquidity. Amounts are what the ledgers recorded so far, shown as wallets show the stock.

const stockAmount = (amount, asset) => amount?.shown == null ? null : `${formatTokenAmount(amount.shown, asset.decimals)} ${asset.symbol}`
const exactAmount = (amount, asset) => amount?.shown == null ? undefined : `${formatUnits(amount.shown, asset.decimals)} ${asset.symbol}`

// The launcher as people know them: the X handle the launcher wallet linked by signature, else the short wallet address.
const launcherHandle = async wallet => { try { return await xHandleFor(wallet) } catch { return null } }
const Launcher = ({ wallet, link }) => hasXHandle(link) ? <XHandleLink link={link} avatar className={styles.handle}/>
  : <span className={styles.wallet} title={wallet}>{shortWallet(wallet)}</span>

// Details → "Fee routing" tab.
export async function StockFeeRouting({ market }) {
  const [routing, link] = await Promise.all([stockFeeRouting(market), launcherHandle(market.launcherWallet)])
  const asset = routing.asset, symbol = asset?.symbol ?? 'the stock'
  const pair = `$REPOING / ${symbol}`
  return <section id="fee-routing" className={`inner-card ${styles.card}`} aria-labelledby="fee-routing-title" data-code={STOCK_PAIR_NO_OWNER_CLAIM}>
    <h3 id="fee-routing-title">Fee routing</h3>
    <p className={styles.lede}>${market.symbol} trades against {symbol}. Every trade pays its {STOCK_FEE_SPLIT.total} fee in {symbol}, routed by a fixed policy.
      There is no owner claim on a stock pair, and verifying the repository does not change where fees go.</p>
    <ol className={styles.routes}>
      <li className={styles.route} data-route="launcher">
        <span className={styles.share}>{STOCK_FEE_SPLIT.launcher}</span>
        <div className={styles.body}><strong>To the launcher, forever</strong>
          <span className={styles.who}>Launched by <Launcher wallet={market.launcherWallet} link={link}/> · paid in {symbol}</span>
          {!routing.unavailable && <span className={styles.amount} title={exactAmount(routing.launcher, asset)}>{stockAmount(routing.launcher, asset) ?? 'Amount unavailable'} earned so far</span>}</div>
      </li>
      <li className={styles.route} data-route="accumulator">
        <span className={styles.share}>{STOCK_FEE_SPLIT.accumulator}</span>
        <div className={styles.body}><strong>Builder share + repo.ing’s share → permanent {pair} liquidity</strong>
          <span className={styles.who}>Held in {symbol}’s accumulator until it is added to the canonical {pair} pool, locked for good</span>
          {!routing.unavailable && <span className={styles.amount} title={exactAmount(routing.accumulator, asset)}>{stockAmount(routing.accumulator, asset) ?? 'Amount unavailable'} so far</span>}</div>
      </li>
      <li className={`${styles.route} ${styles.minor}`} data-route="meteora">
        <span className={styles.share}>{STOCK_FEE_SPLIT.meteora}</span>
        <div className={styles.body}><strong>Meteora protocol fee</strong></div>
      </li>
    </ol>
    <p className={styles.note} role="status">{routing.unavailable ?? (routing.multiplier === null
      ? `Amounts appear once ${symbol}’s display units can be read.`
      : `Amounts as wallets show ${symbol}${routing.multiplier === '1' ? '' : ` (raw units × ${routing.multiplier})`}. A launch-fee window scales every share alike.`)}</p>
  </section>
}

// Hero headline slot (the "Earned by builders" box on SOL markets), same footprint, no claim action. href: the Fee routing
// tab of this page.
export async function StockFeeHeadline({ market, href = '#fee-routing' }) {
  const routing = await stockFeeRouting(market)
  const asset = routing.asset, symbol = asset?.symbol ?? 'stock'
  const liquidity = routing.unavailable || routing.accumulator?.shown == null ? null : formatTokenAmount(routing.accumulator.shown, asset.decimals)
  const launcher = routing.unavailable ? null : stockAmount(routing.launcher, asset)
  return <div className="earnings-headline" data-code={STOCK_PAIR_NO_OWNER_CLAIM}>
    <span className="earnings-headline-label">Toward $REPOING / {symbol} liquidity</span>
    <strong className="earnings-headline-value" title={routing.unavailable ? undefined : exactAmount(routing.accumulator, asset)}>{liquidity === null ? '—'
      : <>{liquidity}<span className={styles.unit}>{symbol}</span></>}</strong>
    <span className="earnings-headline-detail">{launcher ? `${launcher} to the launcher` : routing.unavailable ?? 'Fee amounts unavailable'}</span>
    <a className="earnings-headline-action note" href={href}>{STOCK_FEE_SPLIT.launcher} to the launcher · no owner claim</a>
  </div>
}
