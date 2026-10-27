'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Globe, Image as ImageIcon, Info, LoaderCircle, Send, Upload } from 'lucide-react'
import { CREATOR_FEE_BPS_CHOICES, WALLET_CAP_BPS_CHOICES, percent } from '../../src/hooklab-launch-menus.mjs'
import { COIN_DESCRIPTION_MAX, coinLinks } from '../../src/hooklab-coin-profile.mjs'
import { SOON_BLOCKS, hookBlock } from '../../src/hooklab-blocks.mjs'
import { BURN_DESCRIPTION, SELECTED_HOOK_NOTE, openFeeSplit } from '../lib/hooklab-open-launch.mjs'
import { HookStartingPrice } from './hooklab-launch-price'
import { HookCatalogSelector } from './hooklab-hook-catalog'
import '../launch-pair.css'

// The creator keeps 75% of the creator fee and repo.ing 25% (platform = floor(gross / 4) per trade).
export const creatorCut = bps => `${(bps * 0.75) / 100}%`
export const platformCut = bps => `${(bps * 0.25) / 100}%`
const XMark = () => <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L1 2h6.4l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.4 3.9H4.6L17.8 20Z"/></svg>
const LINK_ICONS = { x: XMark, website: () => <Globe size={14} aria-hidden="true"/>, telegram: () => <Send size={14} aria-hidden="true"/> }
const LINK_LABELS = { x: 'X', website: 'Website', telegram: 'Telegram' }

// The coin as people will see it: image, ticker, name, its rules and links.
// capLifted: the coin has graduated, so its max per wallet no longer applies.
export function HookCoinPreview({ image, name, symbol, capBps, creatorFeeBps, burnBps = 0, selectedHook = null, profile = null, note, capLifted = false }) {
  const links = profile ? coinLinks(profile) : {}
  const [failed, setFailed] = useState(null)
  const shown = image && image !== failed
  return <div className="launch-token-summary hooks-coin-preview" role="group" aria-label="Coin preview">
    <div className="preview-avatar">{shown ? <img src={image} alt="" onError={() => setFailed(image)}/> : <ImageIcon size={24} aria-hidden="true"/>}</div>
    <div><strong>${symbol || 'TICKER'}</strong><span>{name || 'Coin name'}</span>
      <small>{selectedHook ? 'Custom hook · Wallet limits set by hook' : capLifted ? 'No max per wallet' : `Max ${percent(capBps)} per wallet`} · {percent(creatorFeeBps)} creator fee{burnBps > 0 ? ` · ${percent(burnBps)} burn` : ''}</small>
      {Object.keys(links).length > 0 && <span className="hooks-coin-links">{Object.entries(links).map(([key, href]) => {
        const Icon = LINK_ICONS[key]
        return <a key={key} href={href} target="_blank" rel="noopener noreferrer"><Icon/>{LINK_LABELS[key]}</a>
      })}</span>}
      {note && <small>{note}</small>}</div>
  </div>
}

// Upload-only version of the repository token image picker (same look, same 2 MB limit and 512 px result).
export function HookCoinImagePicker({ value, onChange, onBusyChange, disabled }) {
  const [uploading, setUploading] = useState(false), [error, setError] = useState('')
  const input = useRef(null), controller = useRef(null)
  useEffect(() => { onBusyChange?.(uploading) }, [uploading, onBusyChange])
  useEffect(() => () => controller.current?.abort(), [])
  async function upload(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    if (file.size > 2 * 1024 * 1024) { setError('Choose an image up to 2 MB.'); return }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setError('Choose a PNG, JPEG, WebP or GIF image.'); return }
    controller.current?.abort()
    const current = new AbortController(); controller.current = current
    setUploading(true)
    try {
      const response = await fetch('/api/hook-lab/coin-image', { method: 'POST', body: file, headers: { 'content-type': file.type }, signal: current.signal })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw Error(result.error || 'Could not use this image. Try another one.')
      onChange(result.image)
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message || 'Upload failed. Please try again.') }
    finally { if (!current.signal.aborted) setUploading(false) }
  }
  const busy = disabled || uploading
  return <section className="token-image-picker" aria-label="Coin image" aria-busy={uploading}>
    <div className="image-picker-current">
      <div className="image-picker-preview">{value ? <img src={value} alt="Your coin image"/> : <ImageIcon size={32} aria-hidden="true"/>}</div>
      <div className="image-picker-copy"><strong>{uploading ? 'Preparing your image…' : value ? 'Looks good' : 'Add your coin image'}</strong>
        <span>Square works best. PNG, JPEG, WebP or GIF, up to 2 MB.</span>
        <button type="button" className="button outline" disabled={busy} onClick={() => input.current?.click()}>
          {uploading ? <LoaderCircle className="image-picker-spinner" size={16} aria-hidden="true"/> : <Upload size={16} aria-hidden="true"/>} {value ? 'Change image' : 'Upload image'}</button>
      </div>
    </div>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={busy} onChange={upload} aria-label="Upload coin image"/>
    <div className="image-picker-feedback" aria-live="polite">{error && <p className="inline-error" role="alert">{error}</p>}</div>
  </section>
}

function Presets({ label, choices, value, onChange, disabled, format }) {
  return <div className={`launch-buy-presets hooks-presets-${choices.length}`} role="group" aria-label={label}>
    {choices.map(bps => <button key={bps} type="button" aria-pressed={value === bps} disabled={disabled} onClick={() => onChange(bps)}>{format(bps)}</button>)}
  </div>
}

// Everything a creator fills in. form: { name, symbol, image, description, x, website, telegram, capBps, creatorFeeBps }.
// menus: the choices the chain offers right now ({ creatorFeeBps, capBps }); the owner's release menus when absent.
export function HookCoinFields({ form, set, disabled, onImageBusy, menus = null, allowSelectedHook = false }) {
  const characters = [...form.description].length
  return <>
    <label className="field-label" htmlFor="hook-coin-name">Coin name</label>
    <input id="hook-coin-name" className="field-input" maxLength={32} value={form.name} disabled={disabled} autoComplete="off" placeholder="Repo Cat" onChange={event => set({ name: event.target.value })}/>
    <div className="field-hint"><span>The full name people see.</span><span>{form.name.length}/32</span></div>

    <label className="field-label" htmlFor="hook-coin-symbol">Ticker</label>
    <input id="hook-coin-symbol" className="field-input" maxLength={10} value={form.symbol} disabled={disabled} autoComplete="off" placeholder="RCAT"
      onChange={event => set({ symbol: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}/>
    <div className="field-hint"><span>Letters and numbers, shown as ${form.symbol || 'TICKER'}.</span><span>{form.symbol.length}/10</span></div>

    <div className="field-label">Coin image</div>
    <HookCoinImagePicker value={form.image} onChange={image => set({ image })} onBusyChange={onImageBusy} disabled={disabled}/>

    <label className="field-label" htmlFor="hook-coin-description">Description <span className="muted">(optional)</span></label>
    <textarea id="hook-coin-description" className="field-input hooks-textarea" rows={3} value={form.description} disabled={disabled}
      placeholder="What is this coin about?" onChange={event => set({ description: event.target.value })}/>
    <div className="field-hint"><span>One or two sentences.</span><span className={characters > COIN_DESCRIPTION_MAX ? 'hooks-over' : undefined}>{characters}/{COIN_DESCRIPTION_MAX}</span></div>

    <fieldset className="hooks-links" disabled={disabled}>
      <legend className="field-label">Links <span className="muted">(optional)</span></legend>
      <label className="hooks-link-input"><span><XMark/> X</span><input value={form.x} placeholder="@yourcoin or x.com/yourcoin" autoComplete="off" onChange={event => set({ x: event.target.value })}/></label>
      <label className="hooks-link-input"><span><Globe size={14} aria-hidden="true"/> Website</span><input value={form.website} placeholder="yourcoin.xyz" inputMode="url" autoComplete="off" onChange={event => set({ website: event.target.value })}/></label>
      <label className="hooks-link-input"><span><Send size={14} aria-hidden="true"/> Telegram</span><input value={form.telegram} placeholder="t.me/yourcoin" autoComplete="off" onChange={event => set({ telegram: event.target.value })}/></label>
    </fieldset>

    <HookBlocks form={form} set={set} disabled={disabled} menus={menus} allowSelectedHook={allowSelectedHook}/>
  </>
}

function BlockHeader({ id, state }) {
  const block = hookBlock(id)
  return <header><img src={block.icon} width={40} height={40} alt="" decoding="async"/><div><strong>{block.title}</strong><span>{block.summary}</span></div>{state}</header>
}

// Blank fields stay invalid until explicitly completed; omission preserves the hook's defaults.
export function HookSelectedEconomics({ form, set, disabled }) {
  const number = value => value === '' ? '' : Number(value)
  const input = (id, label, value, min, max, change) => <label className="field-label" htmlFor={id}>{label} ({min}–{max} bps)
    <input id={id} className="field-input" type="number" step="1" min={min} max={max} value={value ?? ''} onChange={e => change(number(e.target.value))}/></label>
  return <details className="launch-customize" open={form.quoteCut !== undefined || form.authorShareBps !== undefined || form.rules !== undefined ? true : undefined}>
    <summary>Advanced economics (optional)</summary>
    <fieldset className="launch-customize-body" disabled={disabled}>
      <legend>Custom hook fees and burns</legend>
      <p className="launch-buy-hint">All amounts use basis points (bps): 100 bps = 1%. Leave options unconfigured to keep the hook’s defaults. Choosing a different hook keeps these values, so review them again. Your creator wallet receives the author share; a separate recipient is not supported.</p>
      <label className="field-label" htmlFor="hook-quote-cut">Custom SOL cut limits</label>
      <select id="hook-quote-cut" className="field-input" value={form.quoteCut === undefined ? 'omit' : 'configure'} onChange={e => set({ quoteCut: e.target.value === 'omit' ? undefined : { maxBuyBps: '', maxSellBps: '' } })}>
        <option value="omit">Unconfigured (hook defaults)</option><option value="configure">Configure limits</option>
      </select>
      {form.quoteCut !== undefined && <>
        {input('hook-max-buy', 'Maximum buy SOL cut', form.quoteCut.maxBuyBps, 1, 1000, maxBuyBps => set({ quoteCut: { ...form.quoteCut, maxBuyBps } }))}
        {input('hook-max-sell', 'Maximum sell SOL cut', form.quoteCut.maxSellBps, 0, 1000, maxSellBps => set({ quoteCut: { ...form.quoteCut, maxSellBps } }))}
      </>}
      <label className="field-label" htmlFor="hook-author-share">Author share of creator revenue</label>
      <select id="hook-author-share" className="field-input" value={form.authorShareBps === undefined ? 'omit' : 'configure'} onChange={e => set({ authorShareBps: e.target.value === 'omit' ? undefined : '' })}>
        <option value="omit">Unconfigured (hook defaults)</option><option value="configure">Configure author share</option>
      </select>
      {form.authorShareBps !== undefined && input('hook-author-bps', 'Author share', form.authorShareBps, 0, 5000, authorShareBps => set({ authorShareBps }))}
      <label className="field-label" htmlFor="hook-burn-rules">Token burn rules</label>
      <select id="hook-burn-rules" className="field-input" value={form.rules === undefined ? 'omit' : form.rules === 'none' ? 'none' : 'configure'} onChange={e => set({ rules: e.target.value === 'omit' ? undefined : e.target.value === 'none' ? 'none' : { burnBuyBps: '', burnSellBps: '' } })}>
        <option value="omit">Unconfigured (hook defaults)</option><option value="none">Explicitly no burn rules</option><option value="configure">Configure burns</option>
      </select>
      {form.rules !== undefined && form.rules !== 'none' && <>
        {input('hook-burn-buy', 'Buy token burn', form.rules.burnBuyBps, 0, 10000, burnBuyBps => set({ rules: { ...form.rules, burnBuyBps } }))}
        {input('hook-burn-sell', 'Sell token burn', form.rules.burnSellBps, 0, 10000, burnSellBps => set({ rules: { ...form.rules, burnSellBps } }))}
      </>}
    </fieldset>
  </details>
}

export function HookEconomicsReview({ coin }) {
  if (!coin.selectedHook) return null
  return <div className="inner-card fee-breakdown" aria-label="Configured custom hook economics">
    <h3>Custom hook fees and burns</h3>
    <p>Gross creator fee: {percent(coin.creatorFeeBps)}. repo.ing receives floor(gross / 4); the creator receives the remainder, then any configured author share is deducted. Custom SOL cuts join the same quote fee budget, not an additional SOL charge. The token tax split is unchanged; each trade shows checked amounts before approval.</p>
    <p>Your creator wallet receives the author share too. It does not go to a separate recipient.</p>
    <dl>
      <div><dt>Custom SOL cut limits</dt><dd>{coin.quoteCut === undefined ? 'Unconfigured (hook defaults)' : `Buy maximum ${coin.quoteCut.maxBuyBps} bps · Sell maximum ${coin.quoteCut.maxSellBps} bps`}</dd></div>
      <div><dt>Author share of creator revenue</dt><dd>{coin.authorShareBps === undefined ? 'Unconfigured (hook defaults)' : `${coin.authorShareBps} bps`}</dd></div>
      <div><dt>Token burn rules</dt><dd>{coin.rules === undefined ? 'Unconfigured (hook defaults)' : coin.rules === 'none' ? 'Explicitly none' : `Buy ${coin.rules.burnBuyBps} bps · Sell ${coin.rules.burnSellBps} bps`}</dd></div>
    </dl>
  </div>
}

// One total fee split between the creator and a token burn (owner design 2026-10-27), shown when Burn is on. The shares
// add up to 100%: the burn's share is chosen, the creator takes the rest; Holders Earn is coming and cannot be chosen.
// form.feeTotalBps and form.burnShareBps drive it; creatorFeeBps and rules are derived for the launch.
export function HookFeeSplit({ form, set, disabled, menus, state }) {
  const totalBps = form.feeTotalBps ?? form.creatorFeeBps, burnShareBps = form.burnShareBps ?? 0
  const fee = openFeeSplit(menus, { totalBps, burnShareBps }), creatorShareBps = 10000 - burnShareBps
  const change = next => {
    const value = { totalBps, burnShareBps, ...next }, result = openFeeSplit(menus, value)
    set({ feeTotalBps: value.totalBps, burnShareBps: value.burnShareBps, creatorFeeBps: result.creatorFeeBps ?? '', rules: result.rules })
  }
  const share = value => Math.min(10000, Math.max(0, Math.round(Number(value) * 100)))
  return <article className="hooks-block is-on hooks-fee-split" aria-label="Fee block">
    <BlockHeader id="creator-fee" state={state}/>
    <label className="field-label" htmlFor="fee-total-percent">Total fee (%)</label>
    <input id="fee-total-percent" className="field-input" type="number" min={0} max={fee.maxTotalBps / 100} step={0.01} required
      value={totalBps === '' ? '' : totalBps / 100} disabled={disabled} aria-describedby="fee-total-limit"
      onChange={e => change({ totalBps: e.target.value === '' ? '' : Math.round(Number(e.target.value) * 100) })}/>
    <p id="fee-total-limit" className="launch-buy-hint">One fee on every buy and sell, from 0% to {percent(fee.maxTotalBps)}, split between the parts below.</p>
    <fieldset className="hooks-fee-shares" disabled={disabled}>
      <legend className="field-label">How the fee is split (shares of the fee)</legend>
      <label htmlFor="fee-share-burn">Burn share (% of the fee)</label>
      <input id="fee-share-burn" type="range" min={0} max={100} step={1} value={burnShareBps / 100} onChange={e => change({ burnShareBps: share(e.target.value) })}/>
      <input id="fee-share-burn-percent" className="field-input" type="number" min={0} max={100} step={0.01} value={burnShareBps / 100} aria-label="Burn share, percent of the fee"
        onChange={e => change({ burnShareBps: e.target.value === '' ? 0 : share(e.target.value) })}/>
      <div className="fee-line"><span>Creator<small>{fee.lines?.creator ?? 'The creator’s part, in SOL (repo.ing keeps a quarter of it).'}</small></span><strong>{percent(creatorShareBps)}</strong></div>
      <div className="fee-line"><span>Burn<small>{BURN_DESCRIPTION}</small></span><strong>{percent(burnShareBps)}</strong></div>
      <div className="fee-line is-soon"><span>Holders Earn<small>Part of every trade paid to the coin’s holders.</small></span><strong id="fee-share-holders">Coming</strong></div>
    </fieldset>
    <p className="launch-buy-hint" aria-live="polite">{fee.lines ? `${fee.lines.total} Worst case: ${percent(totalBps)} of each trade (creator ${percent(fee.creatorFeeBps)}, burn ${percent(fee.burnBps)}).` : ''}</p>
    {fee.problem && <p className="inline-error" role="alert">{fee.problem}</p>}
  </article>
}

// What the coin does, as blocks snapped onto it. Every launch today carries the two live blocks; the rest are coming.
export function HookBlocks({ form, set, disabled, menus = null, allowSelectedHook = false }) {
  const caps = menus?.capBps?.length ? menus.capBps : WALLET_CAP_BPS_CHOICES, fees = menus?.creatorFeeBps?.length ? menus.creatorFeeBps : CREATOR_FEE_BPS_CHOICES
  const selected = form.hookKind === 'selected' || !!form.selectedHook, burn = !selected && menus?.burnEnabled === true
  const on = <span className="hooks-block-state"><Check size={13} aria-hidden="true"/>On</span>
  // With Burn on, burns are part of the fee block, not a block on the way.
  const soon = burn ? SOON_BLOCKS.filter(block => block.id !== 'burns') : SOON_BLOCKS
  return <section className="hooks-blocks" aria-labelledby="hooks-blocks-title">
    <div className="hooks-blocks-head"><h3 id="hooks-blocks-title" className="field-label">Blocks</h3><span>Snap on what your coin does.</span></div>
    {allowSelectedHook && <>
      <label className="field-label" htmlFor="hook-kind">Hook configuration</label>
      <select id="hook-kind" className="field-input" value={selected ? 'selected' : 'max-wallet'} disabled={disabled}
        onChange={event => set(event.target.value === 'selected' ? { hookKind: 'selected', selectedHook: { program: '', flags: '' }, hookPublication: undefined, capBps: 0 } : { hookKind: 'max-wallet', selectedHook: undefined, hookPublication: undefined, quoteCut: undefined, authorShareBps: undefined, rules: undefined, capBps: caps[0] })}>
        <option value="max-wallet">Max-wallet gate</option><option value="selected">Choose a compatible hook</option>
      </select>
      {selected && <HookCatalogSelector form={form} set={set} disabled={disabled}/>}
      {selected && <HookSelectedEconomics form={form} set={set} disabled={disabled}/>}
    </>}
    {!selected && <article className="hooks-block is-on" aria-label="Max wallet block">
      <BlockHeader id="max-wallet" state={on}/>
      <Presets label="Max per wallet" choices={caps} value={form.capBps} onChange={capBps => set({ capBps })} disabled={disabled} format={percent}/>
      <p className="launch-buy-hint">No wallet can hold more than {percent(form.capBps)} of the supply until your coin graduates, so early buyers can’t corner it.</p>
    </article>}
    {burn ? <HookFeeSplit form={form} set={set} disabled={disabled} menus={menus} state={on}/> : <article className="hooks-block is-on" aria-label="Creator fee block">
      <BlockHeader id="creator-fee" state={on}/>
      {selected ? <>
        <label className="field-label" htmlFor="selected-creator-fee">Creator fee (bps)</label>
        <input id="selected-creator-fee" className="field-input" type="number" min={0} max={menus?.maxCreatorFeeBps} step={1} required value={form.creatorFeeBps}
          disabled={disabled || !Number.isInteger(menus?.maxCreatorFeeBps)} aria-describedby="selected-creator-fee-limit"
          onChange={e => set({ creatorFeeBps: e.target.value === '' ? '' : Number(e.target.value) })}/>
        <p id="selected-creator-fee-limit">{Number.isInteger(menus?.maxCreatorFeeBps) ? `Choose an integer from 0 to ${menus.maxCreatorFeeBps} bps (100 bps = 1%). Current chain ceiling.` : 'Waiting for the current chain fee ceiling.'}</p>
      </> : menus?.continuousCreatorFee ? <>
        <label className="field-label" htmlFor="creator-fee-percent">Creator fee (%)</label>
        <input id="creator-fee-percent" className="field-input" type="number" min={0} max={menus.maxCreatorFeeBps / 100} step={0.01} required
          value={form.creatorFeeBps === '' ? '' : form.creatorFeeBps / 100} disabled={disabled} aria-describedby="creator-fee-limit"
          onChange={e => set({ creatorFeeBps: e.target.value === '' ? '' : Math.round(Number(e.target.value) * 100) })}/>
        <p id="creator-fee-limit">Choose any fee from 0% to {percent(menus.maxCreatorFeeBps)}, in steps of 0.01%.</p>
      </> : <Presets label="Creator fee" choices={fees} value={form.creatorFeeBps} onChange={creatorFeeBps => set({ creatorFeeBps })} disabled={disabled} format={percent}/>}
      <p className="launch-buy-hint">{selected ? 'The settled creator fee is the gross fee: repo.ing receives floor(gross / 4); the creator receives the remainder, then any configured author share is deducted. Custom SOL cuts join the same quote fee budget, not an additional SOL charge. The token tax split is unchanged. Amounts are checked before each approval.' : `Every buy and sell pays ${percent(form.creatorFeeBps)}. You earn ${creatorCut(form.creatorFeeBps)} of each trade in SOL; repo.ing keeps ${platformCut(form.creatorFeeBps)}.`}</p>
    </article>}
    <p className="hooks-blocks-soon-title">More blocks are on the way</p>
    <ul className="hooks-blocks-soon">{soon.map(block => <li key={block.id} className="hooks-block is-soon">
      <BlockHeader id={block.id} state={<span className="hooks-block-state is-soon">Soon</span>}/></li>)}</ul>
  </section>
}

// The side column: how launching works and what each trade pays.
// launchPrice: undefined while USD launch pricing is off (no price card), else today's estimate or null (see HookStartingPrice).
// open: a self-serve launch (no request or approval step).
export function HookLaunchNotes({ capBps, creatorFeeBps, selectedHook = null, launchPrice, open = false }) {
  return <>
    <div className="inner-card discovery-launch hooks-how"><h3>How launching works</h3>
      {selectedHook ? <p>{SELECTED_HOOK_NOTE}</p> : open ? <ol>
        <li><strong>Make your coin.</strong> A name, ticker, image and your rules.</li>
        <li><strong>Check the costs.</strong> Everything you pay is listed before you sign.</li>
        <li><strong>Approve twice in your wallet.</strong> Once to set up your coin, once to open trading.</li>
        <li><strong>Your coin is live.</strong> Anyone can buy and sell it on repo.ing, in SOL.</li>
      </ol> : <ol>
        <li><strong>Send your request.</strong> Free, and nothing to sign yet.</li>
        <li><strong>repo.ing approves it.</strong> We check each coin and invite you on this page.</li>
        <li><strong>Sign two steps in your wallet.</strong> Keep about 0.05 SOL for account deposits and network fees. Your wallet shows the exact amount first.</li>
        <li><strong>Your coin is live.</strong> Anyone can buy and sell it on repo.ing.</li>
      </ol>}
    </div>
    {launchPrice !== undefined && <HookStartingPrice price={launchPrice} open={open}/>}
    <div className="inner-card fee-breakdown"><h3>Every trade</h3>
      <div className="fee-line"><span>Creator fee<small>Paid by every buy and sell</small></span><strong>{percent(creatorFeeBps)}</strong></div>
      <div className="fee-line"><span>You earn<small>{selectedHook ? 'Remainder after platform share, before configured author share' : '75% of the creator fee, in SOL'}</small></span><strong>{creatorCut(creatorFeeBps)}</strong></div>
      <div className="fee-line"><span>repo.ing<small>{selectedHook ? 'floor(gross creator fee / 4), deducted from gross' : '25% of the creator fee'}</small></span><strong>{platformCut(creatorFeeBps)}</strong></div>
      <div className="fee-line"><span>{selectedHook ? 'Custom hook' : 'Max per wallet'}<small>{selectedHook ? 'Token fees, burns and custom SOL fees are checked before each trade approval' : 'Until the coin graduates'}</small></span><strong>{selectedHook ? 'Wallet limits set by hook' : percent(capBps)}</strong></div>
      <div className="fee-note"><Info size={18} aria-hidden="true"/><span>Hooks coins run on repo.ing’s Hook Lab programs, not as standard Solana tokens, so most wallets and explorers won’t list them yet. Buy and sell them on repo.ing.</span></div>
    </div>
  </>
}
