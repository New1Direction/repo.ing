'use client'
import { useEffect, useMemo, useState } from 'react'
import { DetailsTabs } from './details-tabs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import { appendOlderTrades, coinAmount, explorerAddress, explorerTx, hookActivityUrl, mergeTradePage, percentLabel, shortAddress, shortAge } from '../lib/hooklab-coin-display.mjs'

const POLL_MS = 30_000
const AFTER_TRADE_MS = [0, 5_000]
const Skeleton = ({ label, rows = 4 }) => <div className="hooks-activity-loading" role="status" aria-busy="true" aria-label={label}>
  {Array.from({ length: rows }, (_, i) => <span key={i} className="skeleton-text"/>)}</div>
const Wallet = ({ address }) => <a href={explorerAddress(address)} target="_blank" rel="noopener noreferrer" title={address}>{shortAddress(address)}</a>

// Newest first, as the trades API orders them. trades: null while loading.
export function HookTradesList({ trades, symbol, decimals, now, failed = false, more = false, loadingMore = false, syncing = 0, backfilling = false, onMore, onRetry }) {
  if (!trades) return failed ? <div className="hooks-activity-empty" role="status"><strong>Trades are taking a moment to load.</strong>
    {onRetry && <button type="button" className="button outline" onClick={onRetry}>Try again</button>}</div> : <Skeleton label="Loading trades"/>
  const note = (syncing > 0 || backfilling) && <p className="hooks-activity-note" role="status">{syncing > 0 && `${syncing === 1 ? '1 new trade is confirming.' : `${syncing} new trades are confirming.`} It shows up here in a few seconds. `}{backfilling && 'Older trades are still loading.'}</p>
  if (!trades.length) return <>{note}<div className="hooks-activity-empty" role="status"><img src="/launch-icons/discovery-fees.webp" width={48} height={48} alt=""/><strong>No trades yet. Be the first.</strong>
    <span>Every buy and sell shows up here with its wallet, a few seconds after it lands.</span></div></>
  return <>{note}<div className="hooks-table-scroll"><table className="hooks-table hooks-trades-table">
    <caption className="sr-only">{`Trades of $${symbol}, newest first`}</caption>
    <thead><tr><th scope="col">Time</th><th scope="col">Side</th><th scope="col" className="is-number">SOL</th><th scope="col" className="is-number">{`$${symbol}`}</th><th scope="col">Wallet</th></tr></thead>
    <tbody>{trades.map(trade => <tr key={`${trade.signature}:${trade.eventIndex}`}>
      <td><a href={explorerTx(trade.signature)} target="_blank" rel="noopener noreferrer" title={`${new Date(trade.tradedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC · view transaction`}>
        <time dateTime={trade.tradedAt}>{shortAge(trade.tradedAt, now)}</time></a></td>
      <td><span className={`hooks-side is-${trade.side}`}>{trade.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
      <td className="is-number">{/^\d+$/.test(trade.solLamports ?? '') ? formatSolDisplay(trade.solLamports) : '—'}</td>
      <td className="is-number">{coinAmount(trade.tokenBaseUnits, decimals)}</td>
      <td><Wallet address={trade.trader}/></td></tr>)}</tbody></table></div>
    {more && <button type="button" className="button outline hooks-activity-more" onClick={onMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show older trades'}</button>}</>
}

// data: the holders API response (null while loading). The curve and reserve come first, named, then ranked wallets.
export function HookHoldersList({ data, symbol, decimals, failed = false, onRetry }) {
  if (!data) return failed ? <div className="hooks-activity-empty" role="status"><strong>Holders are taking a moment to load.</strong>
    {onRetry && <button type="button" className="button outline" onClick={onRetry}>Try again</button>}</div> : <Skeleton label="Loading holders"/>
  const top = data.holders.filter(h => h.rank !== null && h.rank <= 10).reduce((sum, h) => sum + h.percent, 0)
  return <>
    <p className="hooks-activity-note">{data.holderCount === 1 ? '1 holder' : `${data.holderCount.toLocaleString('en-US')} holders`}{data.holderCount > 0 && ` · top ${Math.min(10, data.holderCount)} hold ${percentLabel(top)}`}</p>
    <div className="hooks-table-scroll"><table className="hooks-table hooks-holders-table">
      <caption className="sr-only">{`Largest holders of $${symbol}`}</caption>
      <thead><tr><th scope="col">#</th><th scope="col">Holder</th><th scope="col" className="is-number">{`$${symbol}`}</th><th scope="col" className="is-number">Share</th></tr></thead>
      <tbody>{data.holders.map(h => <tr key={h.holding} className={h.label ? 'is-labelled' : undefined}>
        <td>{h.rank ?? '—'}</td>
        <td>{h.label ? <span className="hooks-holder-label" title="Holds coins for the market, not a trader">{h.label}</span> : <Wallet address={h.owner}/>}</td>
        <td className="is-number">{coinAmount(h.amount, decimals)}</td>
        <td className="is-number"><span className="hooks-share" style={{ '--share': Math.min(1, h.percent / 100) }}>{percentLabel(h.percent)}</span></td></tr>)}</tbody></table></div>
    {data.holderCount === 0 && <div className="hooks-activity-empty" role="status"><img src="/hook-icons/max-wallet.webp?v=2" width={48} height={48} alt=""/><strong>No holders yet. Be the first.</strong>
      <span>Buyers show up here with their share of the supply.</span></div>}</>
}

async function readJson(url, signal = null) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)].filter(Boolean)) })
  if (!response.ok) throw Error('unavailable')
  return response.json()
}

function TradesPanel({ mint, symbol, decimals, initial }) {
  // list: what is shown ({ trades, next }); page: the newest first page (its syncing and backfilling notes).
  const [page, setPage] = useState(initial), [list, setList] = useState(() => initial && mergeTradePage(null, initial))
  const [failed, setFailed] = useState(false), [loadingMore, setLoadingMore] = useState(false)
  const [now, setNow] = useState(() => Date.now()), [retry, setRetry] = useState(0)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    let active = true, timers = []
    const controller = new AbortController()
    async function refresh() {
      try {
        const result = await readJson(hookActivityUrl(mint, 'trades'), controller.signal)
        if (active) { setPage(result); setList(shown => mergeTradePage(shown, result)); setFailed(false); setNow(Date.now()) }
      }
      catch { if (active) setFailed(true) }
    }
    const onTrade = event => { if (event.detail?.mint === mint) timers = AFTER_TRADE_MS.map(ms => setTimeout(refresh, ms)) }
    const stop = visiblePolling(refresh, POLL_MS)
    window.addEventListener('repoing:trade-confirmed', onTrade)
    return () => { active = false; controller.abort(); stop(); timers.forEach(clearTimeout); window.removeEventListener('repoing:trade-confirmed', onTrade) }
  }, [mint, retry])
  async function more() {
    if (!list?.next || loadingMore) return
    setLoadingMore(true)
    try { const result = await readJson(hookActivityUrl(mint, 'trades', { before: list.next })); setList(shown => appendOlderTrades(shown, result)) }
    catch { /* The button stays; a tap tries again. */ } finally { setLoadingMore(false) }
  }
  return <HookTradesList trades={list?.trades ?? null} symbol={symbol} decimals={decimals} now={now} failed={failed && !list} more={Boolean(list?.next)} loadingMore={loadingMore}
    syncing={page?.syncing ?? 0} backfilling={page?.backfilling ?? false} onMore={more} onRetry={() => setRetry(n => n + 1)}/>
}

// Holders cost a token-program read, so they load only once their tab is opened, then every minute while it stays open.
function HoldersPanel({ mint, symbol, decimals, active, initial }) {
  const [data, setData] = useState(initial), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    let live = true
    const controller = new AbortController()
    const stop = visiblePolling(async () => {
      try { const result = await readJson(hookActivityUrl(mint, 'holders'), controller.signal); if (live) { setData(result); setFailed(false) } }
      catch { if (live) setFailed(true) }
    }, 60_000)
    return () => { live = false; controller.abort(); stop() }
  }, [mint, active, retry])
  return <HookHoldersList data={data} symbol={symbol} decimals={decimals} failed={failed && !data} onRetry={() => setRetry(n => n + 1)}/>
}

// Trades and Holders below the coin card. initialTrades / initialHolders: first API responses (tests, server renders).
export function HookCoinActivity({ mint, symbol, decimals, initialTrades = null, initialHolders = null }) {
  const [tab, setTab] = useState('trades')
  const tabs = useMemo(() => [
    { id: 'trades', label: 'Trades', content: <TradesPanel mint={mint} symbol={symbol} decimals={decimals} initial={initialTrades}/> },
    { id: 'holders', label: 'Holders', content: <HoldersPanel mint={mint} symbol={symbol} decimals={decimals} active={tab === 'holders'} initial={initialHolders}/> },
  ], [mint, symbol, decimals, initialTrades, initialHolders, tab])
  return <section className="hooks-card hooks-activity" aria-label={`$${symbol} activity`}>
    <DetailsTabs tabs={tabs} initial="trades" label={`$${symbol} activity`} onSelect={setTab}/>
    <p className="hooks-activity-foot">Finalized on Solana. Tap a time or a wallet to open it in Solana Explorer.</p>
  </section>
}
