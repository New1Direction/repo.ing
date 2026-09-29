'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { recentTrades, recentTradeAge, recentTradeSol, recentTradeTokens, solscanTx, RECENT_TRADE_LIMIT } from '../lib/recent-trades.mjs'

// Reads the chart's own /trades response (no second poller); space is reserved so it never shifts the page.
export function RecentTrades({ mint, symbol, trades, failed }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer) }, [])
  const rows = recentTrades(trades)
  const loading = !trades && !failed
  return <section className="inner-card recent-trades" aria-labelledby="recent-trades-heading" aria-busy={loading}>
    <div className="recent-trades-heading"><h3 id="recent-trades-heading">Recent trades</h3><Link href={`/token/${mint}?view=activity`}>All activity</Link></div>
    {loading ? <ol className="recent-trades-list" aria-hidden="true">{Array.from({ length: RECENT_TRADE_LIMIT }, (_, index) => <li key={index} className="recent-trade is-placeholder"><span className="skeleton-text"/></li>)}</ol>
      : !rows.length ? <p className="recent-trades-empty" role="status">{failed ? 'Recent trades are temporarily unavailable.' : 'No finalized trades yet.'}</p>
      : <ol className="recent-trades-list">{rows.map(trade => {
        const tokens = recentTradeTokens(trade)
        return <li key={`${trade.signature}:${trade.eventIndex}`} className="recent-trade">
          <span className={`recent-trade-side ${trade.direction}`}>{trade.direction === 'buy' ? 'Buy' : 'Sell'}</span>
          <span className="recent-trade-amount"><strong>{recentTradeSol(trade)}</strong>{tokens && <small>{tokens} {symbol}</small>}</span>
          <time dateTime={trade.tradedAt} title={new Date(trade.tradedAt).toLocaleString()}>{recentTradeAge(trade, now)}</time>
          <a href={solscanTx(trade.signature)} target="_blank" rel="noopener noreferrer" aria-label={`View ${trade.direction} transaction on Solscan`}>Solscan<ArrowUpRight size={13}/></a>
        </li>
      })}</ol>}
    <small className="recent-trades-note">Last {RECENT_TRADE_LIMIT} finalized swaps · updates with the chart</small>
  </section>
}
