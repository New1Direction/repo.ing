'use client'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { percentChange } from '../lib/format.mjs'
import { chartPriceLabel, chartTradeAge } from '../lib/chart-display.mjs'
import { formatUsdMarketCap } from '../lib/market-display.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { DEFAULT_HOOK_INTERVAL, HOOK_CHART_INTERVALS, hookActivityUrl, solAmount } from '../lib/hooklab-coin-display.mjs'

// The site's chart canvas (TradingView Lightweight Charts, as on repository markets), loaded while the page hydrates.
const loadChartCanvas = () => import('./market-chart-canvas')
const ChartCanvas = dynamic(loadChartCanvas, { ssr: false,
  loading: () => <div className="chart-skeleton" role="status"><span className="claim-spinner" aria-hidden="true"/>Preparing chart…</div> })
const POLL_MS = 30_000, STALE_MS = 75_000
// After this visitor's own trade (the trade panel's repoing:trade-confirmed), read again now and once the coin read catches up.
const AFTER_TRADE_MS = [0, 5_000]

// A Hooks coin's price chart, in candles of 1 minute to 1 day: the market cap (price times the mint's supply, as the coin card's)
// or the price per coin, after each finalized swap. In USD at today's SOL price, as repository charts are, with the SOL value
// beside it; in SOL, labelled so, while the SOL/USD price is unknown. solUsd: the server's cached price when the page was
// rendered (null when it had none); each /candles response brings a newer one. initial: a first /candles response.
export function HookCoinChart({ mint, symbol, decimals, supply, solUsd = null, initial = null }) {
  const [interval, setCandleSize] = useState(initial?.interval ?? DEFAULT_HOOK_INTERVAL)
  const [data, setData] = useState(initial), [error, setError] = useState(false), [refreshing, setRefreshing] = useState(!initial)
  const [style, setStyle] = useState(null), [metric, setMetric] = useState('cap'), [retry, setRetry] = useState(0)
  const [now, setNow] = useState(() => Date.now()), [dataAt, setDataAt] = useState(() => Date.now())
  useEffect(() => { try { const saved = localStorage.getItem('repoing:chart-style'); if (['line', 'candles'].includes(saved)) setStyle(saved) } catch { /* Storage is optional. */ } }, [])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    let active = true, timers = []
    const controller = new AbortController()
    async function refresh() {
      setRefreshing(true)
      try {
        const response = await fetch(hookActivityUrl(mint, 'candles', { interval }), { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) })
        if (!response.ok) throw Error('Prices unavailable')
        const result = await response.json()
        if (!active || result.interval !== interval) return
        const at = Date.now()
        setData(result); setDataAt(at); setNow(at); setError(false)
        setStyle(value => value ?? (result.candles.length < 12 ? 'line' : 'candles'))
      } catch { if (active) setError(true) } finally { if (active) setRefreshing(false) }
    }
    const onTrade = event => { if (event.detail?.mint === mint) timers = AFTER_TRADE_MS.map(ms => setTimeout(refresh, ms)) }
    const stop = visiblePolling(refresh, POLL_MS)
    window.addEventListener('repoing:trade-confirmed', onTrade)
    return () => { active = false; controller.abort(); stop(); timers.forEach(clearTimeout); window.removeEventListener('repoing:trade-confirmed', onTrade) }
  }, [mint, interval, retry])
  function chooseStyle(value) {
    setStyle(value)
    try { localStorage.setItem('repoing:chart-style', value) } catch { /* Keep the choice for this visit. */ }
  }

  const capMode = metric === 'cap'
  const supplyCoins = /^\d+$/.test(supply ?? '') ? Number(BigInt(supply)) / 10 ** decimals : null
  const usdPerSol = [data?.solUsd, solUsd].find(price => Number.isFinite(price) && price > 0) ?? null, usd = usdPerSol !== null
  // SOL per coin times this is what the chart plots and the headline shows.
  const solMultiplier = capMode ? supplyCoins : 1, multiplier = solMultiplier && (usd ? solMultiplier * usdPerSol : solMultiplier)
  const latest = data?.latest?.priceSol, shown = data?.interval === interval ? data : null
  const known = Number.isFinite(latest) && Boolean(multiplier)
  const solValue = known ? `${chartPriceLabel(latest * solMultiplier)} SOL` : '—'
  const value = !known ? '—' : !usd ? solValue : capMode ? formatUsdMarketCap(latest * multiplier) : `$${chartPriceLabel(latest * multiplier)}`
  const unitLabel = `${capMode ? 'Market cap' : 'Price'} · ${usd ? 'USD estimate' : capMode ? 'SOL' : 'SOL per coin'}`
  const bars = shown?.candles ?? []
  const change = bars.length > 1 ? percentChange((bars.at(-1).close / bars[0].open - 1) * 100) : null
  const label = HOOK_CHART_INTERVALS.find(([key]) => key === interval)?.[2] ?? interval
  const stale = error || (data && now - dataAt > STALE_MS)
  const age = chartTradeAge(data?.lastTradeAt, now)
  return <section className="chart-card market-chart-card hooks-chart-card" aria-label={`$${symbol} price chart`}>
    <div className="chart-summary"><div className="chart-heading"><span className="chart-symbol">${symbol} <span className="chart-unit">{unitLabel}</span></span>
      <div className="chart-headline"><strong title={usd ? `At today's SOL price ($${usdPerSol.toLocaleString('en-US', { maximumFractionDigits: 2 })}), not historical USD prices` : undefined}>{value}</strong>
        {usd ? known && <small className="hooks-chart-sol">{solValue}</small> : data && <small className="hooks-chart-sol">USD price unavailable</small>}{change && <span className={change.sign >= 0 ? 'chart-up' : 'chart-down'} title="Change from the first to the last price shown">{change.label} <small>{`${label} candles`}</small></span>}</div></div>
      <div className="chart-metrics"><span>24h volume<strong>{data ? solAmount(data.volume24hLamports) : <span className="skeleton-text"/>}</strong></span>
        <span>Trades<strong>{data ? data.totalTrades.toLocaleString('en-US') : <span className="skeleton-text"/>}</strong></span>
        <span>Last trade<strong>{age ?? '—'}</strong></span></div></div>
    <div className="chart-toolbar"><div className="chart-control-group" aria-label="Candle size">{HOOK_CHART_INTERVALS.map(([key, , text]) =>
      <button key={key} aria-pressed={interval === key} onClick={() => { if (key !== interval) { setCandleSize(key); setRefreshing(true) } }}>{text}</button>)}</div>
      <div className="chart-options"><div className="chart-control-group" aria-label="Chart value"><button aria-pressed={!capMode} onClick={() => setMetric('price')}>Price</button><button aria-pressed={capMode} disabled={!supplyCoins} onClick={() => setMetric('cap')}>MCap</button></div>
        <div className="chart-control-group" aria-label="Chart style"><button aria-pressed={(style ?? 'line') === 'line'} onClick={() => chooseStyle('line')}>Line</button><button aria-pressed={style === 'candles'} onClick={() => chooseStyle('candles')}>Candles</button></div></div></div>
    {!data ? <div className="chart-skeleton is-loading" role="status">{error ? <><strong>Prices are taking a moment</strong><button className="button outline" onClick={() => setRetry(n => n + 1)}>Try again</button></>
      : <><span className="claim-spinner" aria-hidden="true"/>Loading prices…</>}</div>
      : data.totalTrades === 0 ? <div className="chart-skeleton hooks-chart-empty" role="status"><strong>No trades yet. Be the first.</strong>
        <span>Buy with SOL on this page. Your trade shows up here a few seconds after it lands.</span></div>
      : <ChartCanvas data={{ ...(shown ?? data), interval: (shown ?? data).intervalSeconds, range: (shown ?? data).interval }} multiplier={multiplier} unit={usd ? 'USD' : 'SOL'}
        valueLabel={`${capMode ? 'market cap' : 'price'} in ${usd ? 'US dollars (estimate)' : 'SOL'}`} style={style ?? 'line'} symbol={`$${symbol}`}>
        {!shown && <div className="chart-period-status" role="status">{refreshing && <span className="claim-spinner" aria-hidden="true"/>}{refreshing ? `Loading ${label} candles` : `${label} candles unavailable`}</div>}
      </ChartCanvas>}
    <div className="chart-footer"><span className={`chart-freshness${stale ? ' is-stale' : ''}`} role="status"><i/>{stale ? 'Update delayed · last prices shown' : data?.syncing ? 'Finalized · a new trade is confirming' : 'Finalized'}</span>
      <button className="chart-refresh" onClick={() => setRetry(n => n + 1)} disabled={refreshing} aria-label="Refresh chart"><RefreshCw size={13} className={refreshing ? 'is-spinning' : ''}/>{stale ? 'Retry' : 'Refresh'}</button></div>
  </section>
}
