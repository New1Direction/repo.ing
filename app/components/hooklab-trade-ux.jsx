'use client'
// Hooks trade box pieces (owner UI pass, 2026-10-28): the one fee number, the pre-sign preview, the max-wallet room, the
// status bar, the loading skeleton and the burned counter. Display only: numbers come from the panel's estimate (the model
// the server reviews with) and the market read.
import { useEffect, useState } from 'react'
import { Check, Flame, X } from 'lucide-react'
import { formatUnits } from '../lib/hooklab-trade-math.mjs'
import { TRADE_STAGES, burnedTotal, capRoom, feeHeadline, tradePreview, tradeStage } from '../lib/hooklab-ux.mjs'
import '../hooks-ux.css'

const amountOf = ({ raw, decimals, unit }, places) => `${formatUnits(raw, decimals, places ?? (decimals === 9 ? 6 : 0))} ${unit}`

// "5% fee: 3% burned, 2% creator" for a coin (holders' share when the coin has one).
export function HookFeeHeadline({ market, className = 'hooks-fee-headline' }) {
  if (!market) return null
  const { text } = feeHeadline({ creatorFeeBps: market.creatorFeeBps, burnBps: market.burnBuyBps ?? 0, holderBps: market.holderBps ?? 0 })
  return <p className={className}>{text}</p>
}

// What this trade does, before anything is signed: you pay, the fee, coins burned, you receive (and the minimum).
export function HookTradePreview({ market, estimate, side, amount }) {
  const preview = tradePreview(market, estimate, { side, amount })
  if (!preview) return null
  return <dl className="hooks-preview" aria-label="Before you sign">
    <div><dt>You pay</dt><dd>{amountOf(preview.pay)}</dd></div>
    <div><dt>Fee <small>({preview.fee.bps / 100}%, in SOL)</small></dt><dd>{formatUnits(preview.fee.lamports, 9, 6)} SOL</dd></div>
    {preview.burned.raw > 0n && <div className="is-burn"><dt>Burned <small>({preview.burned.bps / 100}%)</small></dt><dd>{amountOf(preview.burned, preview.burned.decimals)}</dd></div>}
    <div className="is-receive"><dt>You receive</dt><dd>{amountOf(preview.receive)}</dd></div>
    {preview.minimum.raw !== null && <div className="is-minimum"><dt>At least, after slippage</dt><dd>{amountOf(preview.minimum)}</dd></div>}
  </dl>
}

// "You can hold up to X": the coin's max per wallet and this wallet's room, shown before the click.
export function HookCapRoom({ market, held, connected, onUseMax, maxBuyText }) {
  const room = capRoom(market, held)
  if (!room) return null
  const unit = `$${market.symbol}`, cap = formatUnits(room.capRaw, market.decimals, 0)
  return <p className={`hooks-cap-room${room.full ? ' is-full' : ''}`} role="status">
    You can hold up to <strong>{cap} {unit}</strong> ({market.capBps / 100}% of the supply) until graduation.
    {connected && (room.full ? ' This wallet already holds the most it can.' : <> Room left: <strong>{formatUnits(room.room, market.decimals, 0)} {unit}</strong>.</>)}
    {onUseMax && maxBuyText && <button type="button" className="hooks-text-button" onClick={onUseMax}>Buy the most I can ({maxBuyText})</button>}
  </p>
}

// Sent → confirmed → done, one bar per signing step (instead of a spinner).
export function HookTradeStatusBar({ steps, labelOf, explorer }) {
  if (!steps?.length) return null
  return <ol className="hooks-status" aria-label="Progress">{steps.map((s, i) => {
    const stage = tradeStage(s.status)
    return <li key={i} data-failed={stage.failed || undefined}>
      <div className="hooks-status-head"><strong>{labelOf(s.kind)}</strong>
        {s.signature && <a href={explorer(s.signature)} target="_blank" rel="noopener noreferrer">Receipt</a>}</div>
      <div className="hooks-status-track" role="progressbar" aria-valuemin={0} aria-valuemax={TRADE_STAGES.length - 1} aria-valuenow={Math.max(0, stage.index)}
        aria-valuetext={stage.failed ? 'Stopped' : TRADE_STAGES[stage.index]}>
        {TRADE_STAGES.map((label, n) => <span key={label} className={stage.failed ? '' : n < stage.index || (n === stage.index && s.status === 'done') ? 'is-done' : n === stage.index && s.status !== 'todo' ? 'is-now' : ''}>
          {stage.failed && n === 0 ? <X size={12} aria-hidden="true"/> : n < stage.index || s.status === 'done' ? <Check size={12} aria-hidden="true"/> : null}{label}</span>)}
      </div>
      {stage.failed && <small className="hooks-status-stopped">Stopped</small>}
    </li>
  })}</ol>
}

// Placeholder shapes while the coin loads (no layout jump when the panel fills in).
export function HookTradeSkeleton() {
  return <div className="hooks-skeleton" aria-hidden="true"><i className="is-tabs"/><i className="is-field"/><i className="is-field"/><i className="is-button"/></div>
}

// Live total burned on a Burn coin: the mint's supply drop, refreshed with the market poll and after every trade here.
export function HookBurnCounter({ mint, symbol, decimals, initial }) {
  const [market, setMarket] = useState(initial)
  useEffect(() => {
    let stop = false
    const load = async () => {
      try { const r = await fetch(`/api/hook-lab/market/${mint}`, { cache: 'no-store' }); const v = await r.json(); if (!stop && r.ok && v.market) setMarket(v.market) } catch {}
    }
    const timer = setInterval(load, 15_000), onTrade = event => { if (event.detail?.mint === mint) load() }
    window.addEventListener('repoing:trade-confirmed', onTrade)
    return () => { stop = true; clearInterval(timer); window.removeEventListener('repoing:trade-confirmed', onTrade) }
  }, [mint])
  const burned = burnedTotal(market)
  if (!burned) return null
  return <div className="hooks-burned" role="status" aria-live="polite"><Flame size={18} aria-hidden="true"/>
    <div><span>Total burned</span><strong>{formatUnits(burned.raw, decimals, 0)} ${symbol}</strong>
      <small>{burned.bps < 0.01 ? 'under 0.0001' : (burned.bps / 100).toFixed(4)}% of the supply, gone for good</small></div></div>
}
