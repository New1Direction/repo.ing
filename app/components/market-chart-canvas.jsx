'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { chartPriceLabel, chartSeries, chartScaleRange, chartUpdatePlan, chartInitialRange } from '../lib/chart-display.mjs'
import { formatSolDisplay } from '../lib/format.mjs'

export default function MarketChartCanvas({ data, multiplier, unit, style, symbol, children }) {
  const container = useRef(null), api = useRef(null), latest = useRef(null)
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0), [hoverTime, setHoverTime] = useState(null)
  const series = useMemo(() => chartSeries(data, multiplier), [data, multiplier])
  const byTime = useMemo(() => new Map(data.candles.map(bar => [bar.time, bar])), [data.candles])
  latest.current = { data, series, style }

  function resetView() {
    const current = latest.current
    api.current?.line.priceScale().applyOptions({ autoScale: true })
    if (current.series.prices.length) api.current?.chart.timeScale().setVisibleLogicalRange(chartInitialRange(current.series.prices.length, current.style))
  }
  useEffect(() => {
    let disposed = false, chart, observer, frame, nextHover = null, lastHover = null
    setReady(false); setFailed(false)
    import('lightweight-charts').then(({ createChart, AreaSeries, CandlestickSeries, HistogramSeries, ColorType }) => {
      if (disposed) return
      chart = createChart(container.current, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, attributionLogo: true, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: '#32373a55' } },
        rightPriceScale: { borderVisible: false, minimumWidth: 76, scaleMargins: { top: 0.14, bottom: 0.12 } },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2, minBarSpacing: 1, lockVisibleTimeRangeOnResize: true },
        handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
        crosshair: { vertLine: { color: '#7f8892', labelBackgroundColor: '#32373a' }, horzLine: { color: '#7f8892', labelBackgroundColor: '#32373a' } },
      })
      const priceFormat = { type: 'custom', minMove: 1e-15, base: 1e15, formatter: chartPriceLabel }
      const autoscaleInfoProvider = original => chartScaleRange(original())
      const line = chart.addSeries(AreaSeries, { lineColor: '#81e6ad', topColor: '#81e6ad20', bottomColor: '#81e6ad00', lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 2, priceFormat, autoscaleInfoProvider })
      const candles = chart.addSeries(CandlestickSeries, { upColor: '#81e6ad', downColor: '#f28485', borderVisible: false, wickUpColor: '#81e6ad', wickDownColor: '#f28485', priceFormat, autoscaleInfoProvider, visible: false })
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1)
      chart.panes()[0].setStretchFactor(5)
      chart.panes()[1].setStretchFactor(1)
      const theme = () => {
        const css = getComputedStyle(container.current)
        const border = css.getPropertyValue('--border').trim()
        chart.applyOptions({ layout: { textColor: css.getPropertyValue('--muted').trim(), panes: { separatorColor: border } }, grid: { horzLines: { color: border, style: 2 } } })
        const up = css.getPropertyValue('--green-dark').trim(), down = css.getPropertyValue('--red').trim()
        line.applyOptions({ lineColor: up })
        candles.applyOptions({ upColor: up, wickUpColor: up, downColor: down, wickDownColor: down })
      }
      theme()
      observer = new MutationObserver(theme)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      chart.subscribeCrosshairMove(event => {
        nextHover = typeof event.time === 'number' ? event.time : null
        if (frame || nextHover === lastHover) return
        frame = requestAnimationFrame(() => { frame = null; lastHover = nextHover; setHoverTime(nextHover) })
      })
      api.current = { chart, line, candles, volume, fitKey: null, series: null }
      setReady(true)
    }).catch(() => { if (!disposed) setFailed(true) })
    return () => { disposed = true; observer?.disconnect(); cancelAnimationFrame(frame); chart?.remove(); api.current = null }
  }, [retry])

  useEffect(() => {
    if (!ready || !api.current) return
    const state = api.current
    const { line, candles, volume, chart } = state
    const range = chart.timeScale().getVisibleLogicalRange()
    const prices = chartUpdatePlan(state.series?.prices, series.prices)
    const volumes = chartUpdatePlan(state.series?.volumes, series.volumes)
    if (prices.reset) {
      line.setData(series.prices.map(({ time, value }) => value === undefined ? { time } : { time, value }))
      candles.setData(series.prices.map(({ value, ...bar }) => bar))
    } else for (const { value, ...bar } of prices.bars) {
      line.update(value === undefined ? { time: bar.time } : { time: bar.time, value })
      candles.update(bar)
    }
    if (volumes.reset) volume.setData(series.volumes)
    else for (const bar of volumes.bars) volume.update(bar)
    state.series = series
    // Full historical corrections keep the user's viewport. Only a deliberately
    // selected period (or the first point arriving) chooses a new initial view.
    const fitKey = `${data.range}:${data.interval}:${Boolean(series.prices.length)}`
    if (state.fitKey !== fitKey) { resetView(); state.fitKey = fitKey; setHoverTime(null) }
    else if ((prices.reset || volumes.reset) && range) chart.timeScale().setVisibleLogicalRange(range)
  }, [ready, series, data.range, data.interval])

  useEffect(() => {
    if (!ready || !api.current) return
    const { chart, line, candles } = api.current
    line.applyOptions({ visible: style === 'line', lastValueVisible: style === 'line' })
    candles.applyOptions({ visible: style === 'candles', lastValueVisible: style === 'candles' })
    chart.timeScale().applyOptions({ maxBarSpacing: style === 'candles' ? 28 : 0 })
    resetView()
  }, [ready, style])
  useEffect(() => {
    if (!ready || !api.current) return
    const formatter = value => `${unit === 'USD' ? '$' : ''}${chartPriceLabel(value)}`
    for (const item of [api.current.line, api.current.candles]) item.applyOptions({ priceFormat: { type: 'custom', minMove: unit === 'USD' ? 0.000001 : 1e-15, base: unit === 'USD' ? 1e6 : 1e15, formatter } })
    // Dragging the price axis disables autoscaling. A SOL range cannot be
    // reused for USD market cap; refit the shared price scale, preserving time.
    api.current.line.priceScale().applyOptions({ autoScale: true })
  }, [ready, unit])

  function zoom(factor) {
    const scale = api.current?.chart.timeScale(), range = scale?.getVisibleLogicalRange()
    if (!range) return
    // Keep the newest visible trades in view, especially for sparse histories.
    scale.setVisibleLogicalRange({ from: range.to - (range.to - range.from) * factor, to: range.to })
  }
  function keyboard(event) {
    if (event.target !== event.currentTarget) return
    if (['+', '=', '-', 'Home'].includes(event.key)) {
      event.preventDefault()
      if (event.key === 'Home') resetView()
      else zoom(event.key === '-' ? 1.4 : 0.7)
    }
  }
  const current = byTime.get(hoverTime) ?? data.candles.findLast(bar => !bar.orderingPending)
  const label = value => Number.isFinite(multiplier) && multiplier > 0 ? `${unit === 'USD' ? '$' : ''}${chartPriceLabel(value * multiplier)}` : '—'
  return <div className="market-chart-plot">
    <div className="chart-readout" aria-hidden="true">
      <time>{current ? `${new Date(current.time * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC` : 'Finalized trade history'}</time>
      <div className="chart-readout-values">{['open', 'high', 'low', 'close'].map(key => <span key={key}>{key[0].toUpperCase()} <b>{current && !current.orderingPending ? label(current[key]) : '—'}</b></span>)}<span>Vol <b>{current ? `${formatSolDisplay(current.volumeLamports)} SOL` : '—'}</b></span></div>
    </div>
    <div ref={container} className="market-chart-canvas" tabIndex={0} role="region" aria-label={`${symbol} ${unit === 'USD' ? 'estimated market cap' : 'SOL price'} chart. Drag to pan, pinch to zoom, or use plus, minus and Home. Exact prices are in the chart data table below.`} onKeyDown={keyboard}/>
    {!ready && <div className="chart-overlay" role="status">{failed ? <><span>Chart could not load.</span><button className="button outline" onClick={() => setRetry(value => value + 1)}>Retry chart</button></> : <><span className="claim-spinner" aria-hidden="true"/>Preparing chart…</>}</div>}
    <div className="chart-zoom" aria-label="Chart zoom controls"><button onClick={() => zoom(1.4)} aria-label="Zoom chart out"><Minus size={14}/></button><button onClick={() => zoom(0.7)} aria-label="Zoom chart in"><Plus size={14}/></button><button onClick={resetView} aria-label="Reset chart view"><RotateCcw size={14}/></button></div>
    {children}
  </div>
}
