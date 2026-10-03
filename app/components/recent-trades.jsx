'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { recentTrades, recentTradeAge, recentTradeSol, recentTradeTokens, solscanTx, tradeKey, traderHandles } from '../lib/recent-trades.mjs'
import { XHandleLink } from './x-handle-link'

const ROWS = 5
const NO_HANDLES = new Map()

// The traders behind the newest trades who linked X, read again only when a new trade arrives. A failed read leaves the
// rows as they are.
function useTraderHandles(mint, newest) {
  const [handles, setHandles] = useState(NO_HANDLES)
  useEffect(() => {
    if (!newest) return
    const controller = new AbortController()
    fetch(`/api/market/${encodeURIComponent(mint)}/traders`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(body => { if (body) setHandles(traderHandles(body)) })
      .catch(() => { /* Rows keep showing without handles. */ })
    return () => controller.abort()
  }, [mint, newest])
  return handles
}

// One swap: side, SOL and token amounts, the trader's @handle when they linked X, its age and its transaction.
export function RecentTradeRow({ trade, symbol, now, x = null }) {
  const tokens = recentTradeTokens(trade)
  return <li className="recent-trade">
    <span className={`recent-trade-side ${trade.direction}`}>{trade.direction === 'buy' ? 'Buy' : 'Sell'}</span>
    <span className="recent-trade-amount"><strong>{recentTradeSol(trade)}</strong>{x && <XHandleLink link={x} avatar className="recent-trade-x"/>}{tokens && <small>{tokens} {symbol}</small>}</span>
    <time dateTime={trade.tradedAt} title={new Date(trade.tradedAt).toLocaleString()}>{recentTradeAge(trade, now)}</time>
    <a className="recent-trade-tx" href={solscanTx(trade.signature)} target="_blank" rel="noopener noreferrer" aria-label={`View ${trade.direction} transaction on Solscan`}>Solscan<ArrowUpRight size={13}/></a>
  </li>
}

// Reads the chart's own /trades response (no second poller); space is reserved so it never shifts the page.
export function RecentTrades({ mint, symbol, trades, failed }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer) }, [])
  const rows = recentTrades(trades, ROWS)
  const handles = useTraderHandles(mint, rows[0] ? tradeKey(rows[0]) : '')
  const loading = !trades && !failed
  return <section className="inner-card recent-trades" aria-labelledby="recent-trades-heading" aria-busy={loading}>
    <div className="recent-trades-heading"><h3 id="recent-trades-heading">Recent trades</h3><Link href={`/token/${mint}?view=activity`}>All activity →</Link></div>
    {loading ? <ol className="recent-trades-list" aria-hidden="true">{Array.from({ length: ROWS }, (_, index) => <li key={index} className="recent-trade is-placeholder"><span className="skeleton-text"/></li>)}</ol>
      : !rows.length ? <p className="recent-trades-empty" role="status">{failed ? 'Recent trades are temporarily unavailable.' : 'No finalized trades yet.'}</p>
      : <ol className="recent-trades-list">{rows.map(trade => <RecentTradeRow key={tradeKey(trade)} trade={trade} symbol={symbol} now={now} x={handles.get(tradeKey(trade)) ?? null}/>)}</ol>}
    <small className="recent-trades-note">Last {ROWS} finalized swaps · updates with the chart</small>
  </section>
}
