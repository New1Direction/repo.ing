'use client'

// The Hooks launch form (owner redesign 2026-10-27): your coin, trading rules, then a compact preview and cost summary
// with one "Review launch" action. It only lays out the open launch's existing state; HookOpenLaunch keeps the request,
// review and signing flow. Every cost comes from the server's availability response, never a literal here.
import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, Globe, Image as ImageIcon, Info, LoaderCircle, Plus, Send } from 'lucide-react'
import { percent } from '../../src/hooklab-launch-menus.mjs'
import { COIN_DESCRIPTION_MAX } from '../../src/hooklab-coin-profile.mjs'
import { inclusiveCreatorFee } from '../../src/hooklab-inclusive-fee-quote.mjs'
import { OPEN_LAUNCH_NOTE, SELECTED_HOOK_NOTE, openLaunchCosts } from '../lib/hooklab-open-launch.mjs'
import { HookCatalogSelector } from './hooklab-hook-catalog'
import { HookSelectedEconomics } from './hooklab-coin-form'
import { HooksOperationError } from './hooks-ui'
import './hooklab-launch-form.css'

const LAMPORTS_PER_SOL = 1_000_000_000n
const XMark = () => <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L1 2h6.4l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.4 3.9H4.6L17.8 20Z"/></svg>
const isSelected = coin => coin.hookKind === 'selected' || !!coin.selectedHook
// A share of the fee in percent of the trade, exact to the basis point fraction (300 bps → 2.25 / 0.75).
const share = bps => `${Number((bps / 100).toFixed(4))}%`

// The creator's 75% and repo.ing's 25% of a creator fee, as the programs take them on a 1 SOL leg
// (inclusiveCreatorFee: gross = ceil(basis × fee / 10,000), repo.ing = floor(gross / 4), creator = the rest).
export function feeBreakdown(creatorFeeBps) {
  if (!Number.isInteger(creatorFeeBps) || creatorFeeBps < 0) return null
  const { grossQuote, platformQuote, creatorQuote } = inclusiveCreatorFee(LAMPORTS_PER_SOL, creatorFeeBps)
  return { feeBps: creatorFeeBps, creatorBps: creatorFeeBps * 0.75, platformBps: creatorFeeBps * 0.25,
    perSol: { gross: grossQuote, creator: creatorQuote, platform: platformQuote } }
}
// A typed percent as the whole basis points the server takes (3 → 300, 2.57 → 257); '' stays empty for validation.
export const percentToBps = text => text === '' ? '' : Math.round(Number(text) * 100)

function ImageTile({ value, onChange, onBusyChange, disabled }) {
  const [uploading, setUploading] = useState(false), [error, setError] = useState('')
  const input = useRef(null)
  async function upload(event) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    setError('')
    if (file.size > 2 * 1024 * 1024) { setError('Choose an image up to 2 MB.'); return }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setError('Choose a PNG, JPEG, WebP or GIF image.'); return }
    setUploading(true); onBusyChange?.(true)
    try {
      const response = await fetch('/api/hook-lab/coin-image', { method: 'POST', body: file, headers: { 'content-type': file.type } })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw Error(result.error || 'Could not use this image. Try another one.')
      onChange(result.image)
    } catch (cause) { setError(cause.message || 'Upload failed. Please try again.') }
    finally { setUploading(false); onBusyChange?.(false) }
  }
  return <div className="hlf-image">
    <button type="button" className="hlf-image-tile" disabled={disabled || uploading} onClick={() => input.current?.click()} aria-label={value ? 'Change coin image' : 'Add coin image'}>
      {value ? <img src={value} alt=""/> : uploading ? <LoaderCircle size={22} className="image-picker-spinner" aria-hidden="true"/> : <><Plus size={22} aria-hidden="true"/><span>Add image</span></>}
    </button>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={disabled || uploading} onChange={upload} aria-label="Upload coin image"/>
    <small>{uploading ? 'Preparing…' : 'Square, up to 2 MB'}</small>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}

function YourCoin({ coin, set, disabled, onImageBusy }) {
  const characters = [...coin.description].length
  const links = [coin.x, coin.website, coin.telegram].some(Boolean)
  return <section className="hlf-section" aria-labelledby="hlf-coin">
    <h2 id="hlf-coin"><span>01</span>Your coin</h2>
    <div className="hlf-coin-grid">
      <ImageTile value={coin.image} onChange={image => set({ image })} onBusyChange={onImageBusy} disabled={disabled}/>
      <div className="hlf-coin-fields">
        <div className="hlf-row">
          <label className="hlf-field hlf-grow"><span>Name</span>
            <input id="hook-coin-name" aria-label="Coin name" maxLength={32} value={coin.name} disabled={disabled} autoComplete="off" placeholder="Your coin name" onChange={e => set({ name: e.target.value })}/></label>
          <label className="hlf-field hlf-ticker"><span>Ticker</span>
            <input id="hook-coin-symbol" maxLength={10} value={coin.symbol} disabled={disabled} autoComplete="off" placeholder="TICKER"
              onChange={e => set({ symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}/></label>
        </div>
        <label className="hlf-field"><span>Description <em>(optional)</em></span>
          <textarea id="hook-coin-description" rows={2} value={coin.description} disabled={disabled} placeholder="What is your coin about?" onChange={e => set({ description: e.target.value })}/>
          {characters > COIN_DESCRIPTION_MAX * 0.8 && <small className={characters > COIN_DESCRIPTION_MAX ? 'hooks-over' : undefined}>{characters}/{COIN_DESCRIPTION_MAX}</small>}</label>
      </div>
    </div>
    <details className="hlf-more" open={links || undefined}>
      <summary><Plus size={16} aria-hidden="true"/>Website &amp; socials</summary>
      <fieldset className="hlf-links" disabled={disabled}>
        <label><span><XMark/> X</span><input value={coin.x} placeholder="@yourcoin" autoComplete="off" onChange={e => set({ x: e.target.value })}/></label>
        <label><span><Globe size={14} aria-hidden="true"/> Website</span><input value={coin.website} placeholder="yourcoin.xyz" inputMode="url" autoComplete="off" onChange={e => set({ website: e.target.value })}/></label>
        <label><span><Send size={14} aria-hidden="true"/> Telegram</span><input value={coin.telegram} placeholder="t.me/yourcoin" autoComplete="off" onChange={e => set({ telegram: e.target.value })}/></label>
      </fieldset>
    </details>
  </section>
}

function CreatorFee({ coin, set, disabled, menus }) {
  const max = Number.isInteger(menus?.maxCreatorFeeBps) ? menus.maxCreatorFeeBps : null
  const split = feeBreakdown(coin.creatorFeeBps)
  if (!menus?.continuousCreatorFee) {
    const fees = menus?.creatorFeeBps ?? []
    return <div className="hlf-segments" role="group" aria-label="Creator fee">{fees.map(bps =>
      <button key={bps} type="button" aria-pressed={coin.creatorFeeBps === bps} disabled={disabled} onClick={() => set({ creatorFeeBps: bps })}>{percent(bps)}</button>)}</div>
  }
  const value = coin.creatorFeeBps === '' ? '' : coin.creatorFeeBps / 100
  const change = text => set({ creatorFeeBps: percentToBps(text) })
  return <>
    <div className="hlf-percent"><input id="creator-fee-percent" type="number" inputMode="decimal" min={0} max={max === null ? undefined : max / 100} step={0.01} value={value}
      disabled={disabled || max === null} aria-describedby="creator-fee-split" onChange={e => change(e.target.value)}/><span>%</span></div>
    <div className="hlf-slider"><span>0%</span>
      <input type="range" min={0} max={max ?? 0} step={1} value={Number.isInteger(coin.creatorFeeBps) ? coin.creatorFeeBps : 0} disabled={disabled || max === null}
        aria-label="Creator fee" aria-valuetext={percent(coin.creatorFeeBps || 0)} onChange={e => set({ creatorFeeBps: Number(e.target.value) })}
        style={{ '--fill': `${max ? (Number(coin.creatorFeeBps) || 0) / max * 100 : 0}%` }}/>
      <span>{max === null ? '—' : percent(max)}</span></div>
    <p id="creator-fee-split" className="hlf-hint"><strong>You receive 75% · repo.ing receives 25%</strong>
      {split && <span>At {percent(split.feeBps)}: {share(split.creatorBps)} to you + {share(split.platformBps)} to repo.ing of every buy and sell, in SOL.</span>}
      {max !== null && <span>Any fee from 0% to {percent(max)}, in steps of 0.01%.</span>}</p>
  </>
}

function TradingRules({ coin, set, disabled, menus, allowSelectedHook }) {
  const selected = isSelected(coin), caps = menus?.capBps ?? []
  return <section className="hlf-section" aria-labelledby="hlf-rules">
    <h2 id="hlf-rules"><span>02</span>Trading rules</h2>
    <div className="hlf-rule"><label htmlFor={selected ? 'selected-creator-fee' : 'creator-fee-percent'}>Creator fee</label><div>
      {selected ? <>
        <div className="hlf-percent"><input id="selected-creator-fee" aria-label="Creator fee (bps)" type="number" min={0} max={menus?.maxCreatorFeeBps} step={1} required value={coin.creatorFeeBps}
          disabled={disabled || !Number.isInteger(menus?.maxCreatorFeeBps)} onChange={e => set({ creatorFeeBps: e.target.value === '' ? '' : Number(e.target.value) })}/><span>bps</span></div>
        <p className="hlf-hint">Gross fee: repo.ing receives floor(gross / 4); you receive the rest, then any author share you configure.</p>
      </> : <CreatorFee coin={coin} set={set} disabled={disabled} menus={menus}/>}
    </div></div>
    {!selected && <div className="hlf-rule"><span className="hlf-rule-label" id="hlf-cap">Max per wallet</span><div>
      <div className="hlf-segments" role="group" aria-labelledby="hlf-cap">{caps.map(bps =>
        <button key={bps} type="button" aria-pressed={coin.capBps === bps} disabled={disabled} onClick={() => set({ capBps: bps })}>{percent(bps)}</button>)}</div>
      <p className="hlf-hint">No wallet can hold more than {percent(coin.capBps)} of the supply until the coin graduates. After graduation the limit lifts.</p>
    </div></div>}
    <div className="hlf-soon" aria-label="Not available yet">
      <span aria-disabled="true"><i aria-hidden="true"/>Burn<small>Coming soon</small></span>
      <span aria-disabled="true"><i aria-hidden="true"/>Holders Earn<small>Coming soon</small></span>
    </div>
    {allowSelectedHook && <details className="hlf-more hlf-advanced" open={selected || undefined}>
      <summary><ChevronDown size={16} aria-hidden="true"/>Advanced: use a custom hook</summary>
      <label className="hlf-field"><span>Hook configuration</span>
        <select id="hook-kind" value={selected ? 'selected' : 'max-wallet'} disabled={disabled}
          onChange={e => set(e.target.value === 'selected' ? { hookKind: 'selected', selectedHook: { program: '', flags: '' }, hookPublication: undefined, capBps: 0 }
            : { hookKind: 'max-wallet', selectedHook: undefined, hookPublication: undefined, quoteCut: undefined, authorShareBps: undefined, rules: undefined, capBps: caps[0] })}>
          <option value="max-wallet">Max-wallet gate (standard)</option><option value="selected">Choose a compatible hook</option>
        </select></label>
      {selected && <HookCatalogSelector form={coin} set={set} disabled={disabled}/>}
      {selected && <HookSelectedEconomics form={coin} set={set} disabled={disabled}/>}
      {selected && <p className="hooks-ended" role="note">{menus?.selectedHooksEnabled ? 'You review hook setup, coin settings and opening trading separately, with three wallet approvals.' : SELECTED_HOOK_NOTE}</p>}
    </details>}
  </section>
}

// The right column: the coin as people will see it, then what launching costs and the one action.
export function HookLaunchSummary({ coin, openCreation, costs, disabled, busyLabel, error = '', errorRef = null }) {
  const selected = isSelected(coin), split = selected ? null : feeBreakdown(coin.creatorFeeBps)
  const { rows, total, need } = openLaunchCosts(selected ? { launchFeeLamports: openCreation?.launchFeeLamports } : openCreation, selected ? {} : costs)
  const [failed, setFailed] = useState(null)
  return <aside className="hlf-summary" aria-label="Coin preview and launch cost">
    <div className="hlf-card hlf-preview">
      <p className="hlf-kicker">Coin preview</p>
      <div className="hlf-preview-head">
        <div className="hlf-avatar">{coin.image && coin.image !== failed ? <img src={coin.image} alt="" onError={() => setFailed(coin.image)}/> : <ImageIcon size={22} aria-hidden="true"/>}</div>
        <div><strong>{coin.name.trim() || 'Your coin'}</strong><span>${coin.symbol || 'TICKER'}</span></div>
      </div>
      <dl>
        <div><dt>Creator fee</dt><dd>{coin.creatorFeeBps === '' ? '—' : selected ? `${coin.creatorFeeBps} bps` : percent(coin.creatorFeeBps)}</dd></div>
        {split && <><div><dt>You receive</dt><dd>{share(split.creatorBps)}</dd></div><div><dt>repo.ing receives</dt><dd>{share(split.platformBps)}</dd></div></>}
        <div><dt>Max per wallet</dt><dd>{selected ? 'Set by hook' : percent(coin.capBps)}</dd></div>
      </dl>
    </div>
    <div className="hlf-card hlf-cost">
      <p className="hlf-kicker">Launch cost</p>
      <dl>
        {rows.map(row => <div key={row.key}><dt>{row.key === 'network' ? 'Network cost' : row.label}</dt><dd>{row.amount ?? 'Shown at review'}</dd></div>)}
        <div><dt>First buy</dt><dd className="hlf-muted">After launch</dd></div>
      </dl>
      <div className="hlf-total"><span>Estimated total</span><strong>{total ?? 'Shown at review'}</strong></div>
      <p className="hlf-fine">{need ? `Keep at least ${need} in your wallet. Exact amounts are shown at review and in your wallet.` : 'Exact amounts are shown at review and in your wallet.'} The launch opens trading; buy your own coin from its page once it’s live.</p>
      <div ref={errorRef} className="hlf-error">{error && <HooksOperationError error={error}/>}</div>
      <button type="submit" className="hlf-primary" disabled={disabled}>{busyLabel ?? <>Review launch <ArrowRight size={18} aria-hidden="true"/></>}</button>
      <p className="hlf-fine hlf-center">Review first. Nothing is signed yet.</p>
    </div>
    <div className="hlf-card hlf-notice">
      <p><Info size={18} aria-hidden="true"/><span>Trade and claim on repo.ing. Some wallets may not display these coins.</span></p>
      <details><summary>Compatibility &amp; risks</summary>
        <p>Hooks coins run on repo.ing’s Hook Lab programs, not the standard Solana token program, so most wallets and explorers won’t list them yet. Buy, sell and claim creator fees here.</p>
        <p>{OPEN_LAUNCH_NOTE}</p>
        <p>repo.ing can still upgrade the launch and trading programs, and like any new coin, a hooks coin can lose all its value.</p>
      </details>
    </div>
  </aside>
}

// The whole first step. Submitting runs the caller's checks and moves to the existing review.
export function HookLaunchForm({ coin, set, disabled, onImageBusy, imageBusy, menus, openCreation, costs, onSubmit, notices, error = '', allowSelectedHook = false }) {
  const busyLabel = imageBusy ? 'Preparing image…' : null, errorRef = useRef(null)
  // A refusal shows by the action; on a phone that is below the fields, so bring it into view.
  useEffect(() => { if (error) errorRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }) }, [error])
  const { total } = openLaunchCosts(isSelected(coin) ? { launchFeeLamports: openCreation?.launchFeeLamports } : openCreation, isSelected(coin) ? {} : costs)
  return <form className="hlf" onSubmit={onSubmit} noValidate>
    <div className="hlf-main">
      {notices}
      <fieldset className="hlf-fieldset" disabled={disabled}>
        <YourCoin coin={coin} set={set} disabled={disabled} onImageBusy={onImageBusy}/>
        <TradingRules coin={coin} set={set} disabled={disabled} menus={menus} allowSelectedHook={allowSelectedHook}/>
      </fieldset>
    </div>
    <HookLaunchSummary coin={coin} openCreation={openCreation} costs={costs} disabled={disabled || imageBusy} busyLabel={busyLabel} error={error} errorRef={errorRef}/>
    <div className="hlf-mobile-bar">
      <div><span>Estimated total</span><strong>{total ?? 'At review'}</strong></div>
      <button type="submit" className="hlf-primary" disabled={disabled || imageBusy}>{busyLabel ?? <>Review launch <ArrowRight size={18} aria-hidden="true"/></>}</button>
    </div>
  </form>
}
