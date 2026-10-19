import { GraduationCap, LockKeyhole, Wallet } from 'lucide-react'
import { formatUnits } from '../lib/hooklab-trade-math.mjs'

const solText = (lamports, places = 3) => `${formatUnits(BigInt(lamports), 9, places)} SOL`
const day = seconds => new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// A Hooks coin's road to graduation on its coin page: progress and the SOL that finishes the curve, then "Graduating…"
// while a full curve waits for anyone to send graduate, then what graduation changed. Plain words for first-time
// visitors; the numbers come from the market reader (src/hooklab-coin-market.mjs).
export function HookCoinGraduation({ market }) {
  const symbol = `$${market.symbol}`, tokens = raw => `${formatUnits(BigInt(raw), market.decimals, 0)} ${symbol}`
  if (market.graduated) {
    const at = market.graduation?.at
    return <div className="hooks-graduation is-graduated" aria-label="Graduation">
      <div className="hooks-between"><span className="hooks-graduated-badge"><GraduationCap size={15} aria-hidden="true"/> Graduated</span>
        {at ? <small>on {day(at)}</small> : null}</div>
      <ul className="hooks-graduation-facts">
        <li><LockKeyhole size={18} aria-hidden="true"/><div><strong>Liquidity locked forever</strong>
          <span>The market’s liquidity belongs to the coin’s launch, which has no way to withdraw it. Not even the creator can pull it.</span></div></li>
        <li><Wallet size={18} aria-hidden="true"/><div><strong>Max wallet lifted</strong><span>Any wallet can hold any amount of {symbol} now.</span></div></li>
      </ul>
      <dl className="hooks-coin-stats hooks-graduation-stats">
        <div><dt>In the market</dt><dd>{solText(market.pool.quoteReserve, 2)}</dd></div>
        <div><dt>Coins in the market</dt><dd>{tokens(market.pool.baseReserve)}</dd></div>
        <div><dt>Creator fee</dt><dd>{market.creatorFeeBps / 100}% per trade</dd></div>
      </dl>
    </div>
  }
  if (market.curveComplete) {
    const g = market.graduation
    return <div className="hooks-curve hooks-graduation is-graduating" role="status" aria-label="Graduation">
      <div className="hooks-between"><span>Bonding curve</span><strong>Graduating…</strong></div>
      <div className="hooks-curve-bar"><span style={{ transform: 'scaleX(1)' }}/></div>
      <p className="hooks-graduation-next"><strong>The curve is full.</strong> Next, {g?.quoteReserve ? <>{solText(g.quoteReserve, 2)} and {tokens(g.baseReserve)}</> : 'the SOL it raised and the coins kept for this moment'} move
        into an open market. That liquidity is locked forever, and the max per wallet lifts. Anyone can send this last step, and it costs holders nothing.</p>
    </div>
  }
  const left = market.solToGraduationLamports, need = BigInt(market.graduationQuote) - BigInt(market.pool.quoteReserve)
  return <div className="hooks-curve" aria-label="Progress to graduation">
    <div className="hooks-between"><span>Bonding curve</span><strong>{(Math.floor(market.curveProgressBps / 10) / 10).toFixed(1)}%</strong></div>
    <div className="hooks-curve-bar"><span style={{ transform: `scaleX(${Math.min(1, market.curveProgressBps / 10000)})` }}/></div>
    <p className="hooks-graduation-next"><strong>{left ? solText(left) : `About ${solText(need > 0n ? need : 0n)}`} to graduation.</strong> Buying
      that much finishes the curve. Then {symbol} moves to an open market: its liquidity is locked forever and anyone can hold any amount.</p>
    <small>Until then, no wallet can hold more than {market.capBps / 100}% of the supply.</small>
  </div>
}
