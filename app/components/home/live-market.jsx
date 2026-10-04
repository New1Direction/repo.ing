'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { RepoAvatar } from '../ui'
import { XHandleLink } from '../x-handle-link'
import { useTraderHandles } from '../recent-trades'
import { marketTradesUrl } from '../../lib/market-chart-urls.mjs'
import { LIVE_MARKET_POLL_MS, LIVE_MARKET_RANGE, LIVE_TRADE_ROWS, lastPoint, liveChart } from '../../lib/live-market.mjs'
import { phoneMarketSummary, sparklinePath } from '../../lib/phone-market-summary.mjs'
import { recentTradeAge, recentTradeSol, tradeKey } from '../../lib/recent-trades.mjs'
import { formatSolDisplay } from '../../lib/format.mjs'

const W = 320, H = 112, PAD = 4

// The home hero's live market (the official $REPOING): the last 24 hours of its price, its change, market cap, volume, what
// its builders have earned, and the newest swaps. Rendered on the server from the chart cache the API serves (renderedAt
// keeps the trade ages the same on both sides), then refreshed from the CDN-cached /trades response while the tab is visible.
export function LiveMarket({ market, initial, usdPerSol = null, renderedAt }) {
  const [chart, setChart] = useState(initial)
  const [now, setNow] = useState(renderedAt)
  const [arrived, setArrived] = useState(() => new Set())
  const seen = useRef(new Set(initial.trades.map(tradeKey)))
  useEffect(() => {
    let active = true, controller = null
    async function refresh() {
      controller?.abort()
      controller = new AbortController()
      try {
        const response = await fetch(marketTradesUrl(market.mint, LIVE_MARKET_RANGE), { cache: 'no-store', signal: controller.signal })
        const next = response.ok ? liveChart(await response.json()) : null
        if (!active || !next) return
        // Swaps the card had not shown slide in once; the first read after the page loads only catches up.
        const added = next.trades.map(tradeKey).filter(key => !seen.current.has(key))
        added.forEach(key => seen.current.add(key))
        setArrived(new Set(added))
        setChart(next)
      } catch { /* The card keeps its last series until the next poll. */ }
    }
    function tick() {
      if (document.visibilityState !== 'visible') return
      setNow(Date.now())
      void refresh()
    }
    setNow(Date.now())
    const timer = setInterval(tick, LIVE_MARKET_POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [market.mint])
  const handles = useTraderHandles(market.mint, chart.trades[0] ? tradeKey(chart.trades[0]) : '')
  const summary = phoneMarketSummary({ priceSol: market.priceSol, volume24hLamports: market.volume24hLamports, chart,
    metrics: usdPerSol ? { solUsd: usdPerSol } : null, now })
  const line = sparklinePath(summary.spark, W, H, PAD)
  const dot = lastPoint(line, W, H)
  const change = Number.isFinite(summary.change) ? summary.change : null, up = change === null || change >= 0
  const changeText = change === null ? null : `${Math.abs(change).toFixed(2)}%`
  return <article className="live-market" aria-labelledby="live-market-title">
    <header className="live-market-head">
      <RepoAvatar repo={market}/>
      <div className="live-market-name"><h2 id="live-market-title">${market.symbol}</h2><span>{market.fullName}</span></div>
      <span className="live-badge"><i aria-hidden="true"/>Live</span>
    </header>
    <div className="live-market-price">
      <strong>{summary.price}</strong>
      {changeText && <span className={`live-change ${up ? 'is-up' : 'is-down'}`}><span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? '' : '−'}{changeText}</span>}
      <small>24h</small>
    </div>
    <div className={`live-chart ${up ? 'is-up' : 'is-down'}`}>
      {line ? <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`$${market.symbol} price over the last 24 hours${changeText ? `, ${up ? 'up' : 'down'} ${changeText}` : ''}`}>
        <defs><linearGradient id="live-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity=".3"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
        <path className="live-chart-area" d={`${line} L${W - PAD} ${H} L${PAD} ${H} Z`} fill="url(#live-chart-fill)"/>
        <path className="live-chart-line" d={line} vectorEffect="non-scaling-stroke"/>
      </svg> : <p className="live-chart-empty">Price history is loading</p>}
      {dot && <span className="live-chart-dot" style={{ left: `${dot.left}%`, top: `${dot.top}%` }} aria-hidden="true"/>}
    </div>
    <dl className="live-market-stats">
      <div><dt>Market cap</dt><dd>{summary.marketCap}</dd></div>
      <div><dt>24h volume</dt><dd>{summary.volume}</dd></div>
      <div><dt>Builders earned</dt><dd>{/^\d+$/.test(market.earned ?? '') ? `${formatSolDisplay(market.earned)} SOL` : '—'}</dd></div>
    </dl>
    <ol className="live-trades" aria-label="Newest trades">
      {chart.trades.slice(0, LIVE_TRADE_ROWS).map(trade => { const key = tradeKey(trade), x = handles.get(key)
        return <li key={key} className={`live-trade${arrived.has(key) ? ' is-new' : ''}`}>
          <span className={`live-trade-side ${trade.direction}`}>{trade.direction === 'buy' ? 'Buy' : 'Sell'}</span>
          <strong>{recentTradeSol(trade)}</strong>
          <span className="live-trade-who">{x && <XHandleLink link={x} avatar/>}</span>
          <time dateTime={trade.tradedAt}>{recentTradeAge(trade, now)}</time>
        </li> })}
    </ol>
    <Link href={`/token/${market.mint}`} className="button primary live-market-cta">Trade ${market.symbol}<ArrowRight size={17} aria-hidden="true"/></Link>
  </article>
}

// Same frame as the card, so streaming it in never moves the hero. unavailable: the market could not be read.
export function LiveMarketFallback({ unavailable = false }) {
  return <article className="live-market is-loading" aria-busy={!unavailable || undefined}>
    <header className="live-market-head"><span className="skeleton-avatar"/><div className="live-market-name"><span className="skeleton-line"/><span className="skeleton-line short"/></div></header>
    <div className="live-market-price"><span className="skeleton-line"/></div>
    <div className="live-chart">{unavailable && <p className="live-chart-empty" role="status">Live prices are temporarily unavailable.</p>}</div>
    <div className="live-market-stats"><span className="skeleton-line"/><span className="skeleton-line"/><span className="skeleton-line"/></div>
  </article>
}
