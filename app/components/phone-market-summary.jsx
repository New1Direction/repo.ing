'use client'
import { useEffect, useState } from 'react'
import { phoneMarketSummary, sparklinePath, stockMarketSummary } from '../lib/phone-market-summary.mjs'
import { readMarketSnapshot, subscribeMarketSnapshot } from '../lib/market-snapshot.mjs'
import { percentChange } from '../lib/format.mjs'
import '../phone-market-summary.css'

const SPARK_WIDTH = 96, SPARK_HEIGHT = 34

// Phones only (CSS shows it at ≤640px): what a trader is buying, before builder earnings and repo details. It makes no
// request of its own: the server market row (last price; 24h volume, the verified DAMM pool included after graduation)
// first, then the trades and metrics the price chart below already loaded. A stock pair (quote: marketQuoteView, stock: the
// row's stock figures) reads the same snapshot in its stock (stockMarketSummary). usdPerSol: the server's SOL/USD price, so the
// server-rendered summary shows USD as the browser's will (the chart's metrics replace it once they load).
export function PhoneMarketSummary({ mint, symbol, priceSol = null, volume24hLamports = null, usdPerSol = null, quote = null, stock = null }) {
  const [snapshot, setSnapshot] = useState(null)
  useEffect(() => {
    setSnapshot(readMarketSnapshot(mint))
    return subscribeMarketSnapshot(mint, setSnapshot)
  }, [mint])
  // The newest price and volume from any chart window, over the latest window long enough for 24h change and sparkline.
  const chart = snapshot?.chart ? { ...snapshot.chart, latest: snapshot.latest, ...(quote ? { volume24hQuote: snapshot.volume24hQuote } : { volume24hLamports: snapshot.volume24hLamports }) } : null
  const summary = quote ? stockMarketSummary({ quote, stock, chart, metrics: snapshot?.metrics ?? null, now: Date.parse(chart?.fetchedAt) || 0 })
    : phoneMarketSummary({ priceSol, volume24hLamports, usdPerSol, chart, metrics: snapshot?.metrics ?? null, now: Date.parse(chart?.fetchedAt) || 0 })
  const path = sparklinePath(summary.spark, SPARK_WIDTH, SPARK_HEIGHT)
  const change = percentChange(summary.change)
  const trend = change === null ? '' : change.sign >= 0 ? ' is-up' : ' is-down'
  return <section className="phone-market-summary" aria-label={`$${symbol} market summary`}>
    <div className="phone-market-price">
      <span>${symbol} price</span>
      <strong className={summary.price.length > 11 ? 'is-long' : undefined}>{summary.price}</strong>
      <em className={`phone-market-change${trend}`} title="Change over the last 24 hours (since the first trade for a younger market)">{change?.label ?? '—'} <small>24h</small></em>
    </div>
    <svg className={`phone-market-spark${trend}`} width={SPARK_WIDTH} height={SPARK_HEIGHT} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} aria-hidden="true">
      {path ? <path d={path}/> : <line x1="2" x2={SPARK_WIDTH - 2} y1={SPARK_HEIGHT / 2} y2={SPARK_HEIGHT / 2}/>}
    </svg>
    <dl className="phone-market-stats">
      <div><dt>Market cap</dt><dd>{summary.marketCap}</dd></div>
      <div><dt>24h volume</dt><dd>{summary.volume}</dd></div>
    </dl>
  </section>
}
