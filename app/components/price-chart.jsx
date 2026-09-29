'use client'
import dynamic from 'next/dynamic'
import { marketPrefetch } from '../lib/market-prefetch.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatSolDisplay } from '../lib/format.mjs'
import { formatUsdMarketCap } from '../lib/market-display.mjs'
import { CHART_PERIODS, chartPriceLabel, chartTradeAge } from '../lib/chart-display.mjs'

const ChartCanvas = dynamic(() => import('./market-chart-canvas'), { ssr: false,
  loading: () => <div className="chart-skeleton" role="status"><span className="claim-spinner" aria-hidden="true"/>Preparing chart…</div> })

export function PriceChart({ mint, symbol, curveStatus, onSolUsd }) {
  const [range, setRange] = useState('all'), [style, setStyle] = useState(null), [metric, setMetric] = useState('cap')
  const [data, setData] = useState(null), [metrics, setMetrics] = useState(null)
  const [error, setError] = useState(false), [metricsError, setMetricsError] = useState(false), [refreshing, setRefreshing] = useState(true)
  const [retry, setRetry] = useState(0), [pendingSignature, setPendingSignature] = useState(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    try { const saved = localStorage.getItem('repoing:chart-style'); if (['line', 'candles'].includes(saved)) setStyle(saved) } catch { /* Storage is optional. */ }
  }, [])
  function chooseStyle(value) {
    setStyle(value)
    try { localStorage.setItem('repoing:chart-style', value) } catch { /* Keep the choice for this visit. */ }
  }
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    let active = true, running = false, queued = false
    const controller = new AbortController()
    const warmed = range === 'all' ? marketPrefetch.take(mint) : null
    if (warmed) { setData(warmed); setRefreshing(false) }
    async function refresh() {
      if (running) { queued = true; return }
      running = true; setRefreshing(true)
      try {
        const response = await fetch(`/api/market/${encodeURIComponent(mint)}/trades?range=${range}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
        if (!response.ok) throw Error('Trade history unavailable')
        const result = await response.json()
        if (result.range !== range) throw Error('Chart period mismatch')
        if (active) {
          setData(result); setError(false); setNow(Date.now())
          setStyle(value => value ?? (result.candles.filter(bar => !bar.orderingPending).length < 12 ? 'line' : 'candles'))
        }
      } catch { if (active) setError(true) }
      finally { running = false; if (active) { setRefreshing(false); if (queued) { queued = false; void refresh() } } }
    }
    function onTradeConfirmed(event) {
      if (event.detail?.mint !== mint || !event.detail.signature) return
      setPendingSignature(event.detail.signature)
      void refresh()
    }
    const onIndexed = event => { if (event.detail?.mint === mint && event.detail.kind !== 'curve') void refresh() }
    window.addEventListener('repoing:market-updated', onIndexed)
    // Indexed trades arrive over SSE (repoing:market-updated); polling is only the fallback.
    const stopPolling = visiblePolling(refresh, 60000)
    window.addEventListener('repoing:trade-confirmed', onTradeConfirmed)
    return () => { active = false; controller.abort(); stopPolling(); window.removeEventListener('repoing:trade-confirmed', onTradeConfirmed); window.removeEventListener('repoing:market-updated', onIndexed) }
  }, [mint, range, retry])
  useEffect(() => {
    if (pendingSignature && data?.trades.some(trade => trade.signature === pendingSignature)) setPendingSignature(null)
  }, [data, pendingSignature])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const stop = visiblePolling(async () => {
      try {
        const response = await fetch(`/api/market/${encodeURIComponent(mint)}/metrics`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
        if (!response.ok) throw Error()
        const result = await response.json()
        if (active) { setMetrics(result); setMetricsError(false); onSolUsd?.(result.solUsd ?? null) }
      } catch { if (active) { setMetricsError(true); onSolUsd?.(null) } }
    }, 30000)
    return () => { active = false; controller.abort(); stop() }
  }, [mint, onSolUsd, retry])

  const graduated = Boolean(data?.graduation) || curveStatus === 'graduated'
  const ended = graduated || curveStatus === 'migrating'
  const hasDammPrices = data?.trades.some(trade => trade.venue === 'DAMM' && trade.priceSol)
  const historyOnly = ended && !hasDammPrices
  // Keep the canvas mounted across requests, including empty periods. The
  // displayed period remains explicit until its replacement actually arrives.
  const current = data
  const stale = error || (data && now - Date.parse(data.fetchedAt) > 45000)
  const freshMetrics = metrics && now - Date.parse(metrics.fetchedAt) < 75000 ? metrics : null
  const supply = freshMetrics?.supplyBaseUnits && freshMetrics?.supplyDecimals !== null && freshMetrics?.supplyDecimals !== undefined
    ? Number(freshMetrics.supplyBaseUnits) / 10 ** freshMetrics.supplyDecimals : null
  const capMultiplier = supply && freshMetrics?.solUsd ? supply * freshMetrics.solUsd : null
  const capMode = metric === 'cap'
  const capUnavailable = capMode && !capMultiplier
  const latest = data?.latest
  const latestValue = latest?.priceSol
  const validBars = current?.candles.filter(bar => !bar.orderingPending) ?? []
  const change = validBars.length > 1 ? (validBars.at(-1).close / validBars[0].open - 1) * 100 : null
  const awaitingRange = !current || current.range !== range
  const periodLabel = value => CHART_PERIODS.find(([key]) => key === value)?.[1] ?? value
  const tradeAge = chartTradeAge(latest?.tradedAt, now)
  const empty = !current?.candles.length
  const emptyMessage = <><strong>{error && !current ? 'Trade history is unavailable' : data?.totalTrades ? 'No trades in this period' : 'Waiting for the first trade'}</strong><span>{error && !current ? 'Your trade form is still available. Retry the chart below.' : data?.totalTrades ? 'Choose All to see the market’s full history.' : 'Your first finalized trade will appear here once indexed.'}</span>{range !== 'all' && !error && <button className="button outline" onClick={() => { setRange('all'); setRefreshing(true) }}>View all history</button>}</>
  return <section className="chart-card market-chart-card" aria-label={`${symbol} market chart`}>
    <div className="chart-summary"><div className="chart-heading"><span className="chart-symbol">${symbol} <span className="chart-unit">{capMode ? 'Market cap · USD estimate' : 'Price · SOL'}</span></span>
      <div className="chart-headline"><strong>{latestValue && !capUnavailable ? capMode ? formatUsdMarketCap(latestValue * capMultiplier) : chartPriceLabel(latestValue) : '—'}</strong>{change !== null && <span className={change >= 0 ? 'chart-up' : 'chart-down'} title="Change from the first to last recorded price in the displayed period">{change > 0 ? '+' : ''}{change.toFixed(2)}% <small>{periodLabel(current.range)}</small></span>}</div>
    </div><div className="chart-metrics"><span>{data?.graduation ? '24h total volume' : ended ? '24h curve volume' : '24h volume'}<strong>{data ? `${formatSolDisplay(data.volume24hLamports)} SOL` : <span className="skeleton-text"/>}</strong></span><span>{historyOnly ? 'Last curve cap' : 'Market cap'}<strong>{latestValue && capMultiplier ? formatUsdMarketCap(latestValue * capMultiplier) : '—'}</strong></span><span>Holders<strong>{ended || freshMetrics?.holders == null ? '—' : freshMetrics.holders.toLocaleString('en-US')}</strong></span></div></div>
    <div className="chart-toolbar"><div className="chart-control-group" aria-label="Chart period">{CHART_PERIODS.map(([value, label]) => <button key={value} aria-pressed={range === value} onClick={() => { if (value !== range) { setRange(value); setRefreshing(true); setError(false) } }}>{label}</button>)}</div>
      <div className="chart-options"><div className="chart-control-group" aria-label="Chart value"><button aria-pressed={!capMode} onClick={() => setMetric('price')}>Price</button><button aria-pressed={capMode} disabled={!capMultiplier && !capMode} onClick={() => setMetric('cap')}>MCap</button></div><div className="chart-control-group" aria-label="Chart style"><button aria-pressed={style === 'line'} onClick={() => chooseStyle('line')}>Line</button><button aria-pressed={style === 'candles'} onClick={() => chooseStyle('candles')}>Candles</button></div></div>
    </div>
    {current ? <ChartCanvas data={current} multiplier={capMode ? capMultiplier : 1} unit={capMode ? 'USD' : 'SOL'} style={style ?? 'line'} symbol={symbol}>
      {empty ? <div className="chart-overlay chart-empty" role="status">{emptyMessage}</div> : capUnavailable && <div className="chart-overlay chart-empty" role="status"><strong>{metricsError || metrics ? 'USD estimate is unavailable' : 'Loading market cap…'}</strong><span>SOL prices are available independently.</span><button className="button outline" onClick={() => setMetric('price')}>Show SOL price</button></div>}
      {awaitingRange && <div className="chart-period-status" role="status">{refreshing && <span className="claim-spinner" aria-hidden="true"/>}{refreshing ? `Loading ${periodLabel(range)}` : `${periodLabel(range)} unavailable`} · showing {periodLabel(current.range)}</div>}
    </ChartCanvas> : <div className="chart-skeleton is-loading" role="status">{refreshing ? <><span className="claim-spinner" aria-hidden="true"/>Loading finalized prices…</> : emptyMessage}</div>}
    <div className="chart-footer"><span className={`chart-freshness${stale ? ' is-stale' : ''}`} role="status"><i/>{stale ? 'Update delayed · last verified prices' : historyOnly ? 'Bonding-curve history' : graduated ? 'Finalized · Curve + DAMM' : 'Finalized'}{!stale && tradeAge && <span className="chart-trade-age" title={`${new Date(latest.tradedAt).toISOString()} · no prices are added between trades`}>· Last trade {tradeAge}</span>}</span><button className="chart-refresh" onClick={() => setRetry(value => value + 1)} disabled={refreshing} aria-label="Refresh market chart"><RefreshCw size={13} className={refreshing ? 'is-spinning' : ''}/>{stale ? 'Retry' : 'Refresh'}</button></div>
    {pendingSignature && <p className="chart-notice" role="status">Trade confirmed. Waiting for the finalized swap to be indexed.</p>}
    {(data?.latestOrderingPending || current?.candles.some(bar => bar.orderingPending)) && <p className="chart-notice">Some prices are withheld while price or transaction-order evidence is unavailable. Verified volume is retained.</p>}
    {ended && <p className="chart-notice" role="status">{hasDammPrices ? 'Chart continues through graduation into the same repository’s verified DAMM pool.' : graduated ? 'Waiting for the first indexed DAMM price. Showing the recorded curve history.' : 'Graduation in progress. Curve history stays visible while the destination pool is verified.'}{data?.graduation && <> <a href={`https://solscan.io/tx/${data.graduation.signature}`} target="_blank" rel="noreferrer">Migration receipt ↗</a></>}</p>}
    <details className="chart-data"><summary>Chart details & data</summary><p>Finalized {data?.graduation ? 'DBC and verified DAMM' : 'DBC'} pool spot prices after each swap, grouped by {current?.intervalLabel ?? 'time'}. Line view connects recorded closes; candles show the full open/high/low/close. Quiet markets start in line view. Empty intervals contain no candles. Volume uses recorded pool SOL amounts. USD market cap uses on-chain supply and today’s SOL price, not historical USD prices. Times are UTC.</p>{latest && <p>Last trade: {new Date(latest.tradedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.</p>}
      {validBars.length > 0 && <div className="chart-data-scroll"><table><caption>Most recent price bars · SOL per token</caption><thead><tr><th>UTC</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume (SOL)</th></tr></thead><tbody>{validBars.slice(-20).reverse().map(bar => <tr key={bar.time}><td>{new Date(bar.time * 1000).toISOString().slice(0, 16).replace('T', ' ')}</td>{['open', 'high', 'low', 'close'].map(key => <td key={key}>{chartPriceLabel(bar[key])}</td>)}<td>{formatSolDisplay(bar.volumeLamports)}</td></tr>)}</tbody></table></div>}
      <p>Charts powered by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a>. Copyright (с) 2025 TradingView, Inc.</p>
    </details>
  </section>
}
