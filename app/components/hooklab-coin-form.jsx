'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Globe, Image as ImageIcon, Info, LoaderCircle, Send, Upload } from 'lucide-react'
import { CREATOR_FEE_BPS_CHOICES, WALLET_CAP_BPS_CHOICES, percent } from '../../src/hooklab-launch-menus.mjs'
import { COIN_DESCRIPTION_MAX, coinLinks } from '../../src/hooklab-coin-profile.mjs'
import { SOON_BLOCKS, hookBlock } from '../../src/hooklab-blocks.mjs'
import '../launch-pair.css'

// The creator keeps 75% of the creator fee and repo.ing 25% (platform = floor(gross / 4) per trade).
export const creatorCut = bps => `${(bps * 0.75) / 100}%`
export const platformCut = bps => `${(bps * 0.25) / 100}%`
const XMark = () => <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L1 2h6.4l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.4 3.9H4.6L17.8 20Z"/></svg>
const LINK_ICONS = { x: XMark, website: () => <Globe size={14} aria-hidden="true"/>, telegram: () => <Send size={14} aria-hidden="true"/> }
const LINK_LABELS = { x: 'X', website: 'Website', telegram: 'Telegram' }

// The coin as people will see it: image, ticker, name, its rules and links.
// capLifted: the coin has graduated, so its max per wallet no longer applies.
export function HookCoinPreview({ image, name, symbol, capBps, creatorFeeBps, profile = null, note, capLifted = false }) {
  const links = profile ? coinLinks(profile) : {}
  const [failed, setFailed] = useState(null)
  const shown = image && image !== failed
  return <div className="launch-token-summary hooks-coin-preview" role="group" aria-label="Coin preview">
    <div className="preview-avatar">{shown ? <img src={image} alt="" onError={() => setFailed(image)}/> : <ImageIcon size={24} aria-hidden="true"/>}</div>
    <div><strong>${symbol || 'TICKER'}</strong><span>{name || 'Coin name'}</span>
      <small>{capLifted ? 'No max per wallet' : `Max ${percent(capBps)} per wallet`} · {percent(creatorFeeBps)} creator fee</small>
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
export function HookCoinFields({ form, set, disabled, onImageBusy }) {
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

    <HookBlocks form={form} set={set} disabled={disabled}/>
  </>
}

function BlockHeader({ id, state }) {
  const block = hookBlock(id)
  return <header><img src={block.icon} width={40} height={40} alt="" decoding="async"/><div><strong>{block.title}</strong><span>{block.summary}</span></div>{state}</header>
}

// What the coin does, as blocks snapped onto it. Every launch today carries the two live blocks; the rest are coming.
export function HookBlocks({ form, set, disabled }) {
  const on = <span className="hooks-block-state"><Check size={13} aria-hidden="true"/>On</span>
  return <section className="hooks-blocks" aria-labelledby="hooks-blocks-title">
    <div className="hooks-blocks-head"><h3 id="hooks-blocks-title" className="field-label">Blocks</h3><span>Snap on what your coin does.</span></div>
    <article className="hooks-block is-on" aria-label="Max wallet block">
      <BlockHeader id="max-wallet" state={on}/>
      <Presets label="Max per wallet" choices={WALLET_CAP_BPS_CHOICES} value={form.capBps} onChange={capBps => set({ capBps })} disabled={disabled} format={percent}/>
      <p className="launch-buy-hint">No wallet can hold more than {percent(form.capBps)} of the supply until your coin graduates, so early buyers can’t corner it.</p>
    </article>
    <article className="hooks-block is-on" aria-label="Creator fee block">
      <BlockHeader id="creator-fee" state={on}/>
      <Presets label="Creator fee" choices={CREATOR_FEE_BPS_CHOICES} value={form.creatorFeeBps} onChange={creatorFeeBps => set({ creatorFeeBps })} disabled={disabled} format={percent}/>
      <p className="launch-buy-hint">Every buy and sell pays {percent(form.creatorFeeBps)}. You earn {creatorCut(form.creatorFeeBps)} of each trade in SOL; repo.ing keeps {platformCut(form.creatorFeeBps)}.</p>
    </article>
    <p className="hooks-blocks-soon-title">More blocks are on the way</p>
    <ul className="hooks-blocks-soon">{SOON_BLOCKS.map(block => <li key={block.id} className="hooks-block is-soon">
      <BlockHeader id={block.id} state={<span className="hooks-block-state is-soon">Soon</span>}/></li>)}</ul>
  </section>
}

// The side column: how approval works and what each trade pays.
export function HookLaunchNotes({ capBps, creatorFeeBps }) {
  return <>
    <div className="inner-card discovery-launch hooks-how"><h3>How launching works</h3>
      <ol>
        <li><strong>Send your request.</strong> Free, and nothing to sign yet.</li>
        <li><strong>repo.ing approves it.</strong> We check each coin and invite you on this page.</li>
        <li><strong>Sign two steps in your wallet.</strong> Keep about 0.05 SOL for account deposits and network fees. Your wallet shows the exact amount first.</li>
        <li><strong>Your coin is live.</strong> Anyone can buy and sell it on repo.ing.</li>
      </ol>
    </div>
    <div className="inner-card fee-breakdown"><h3>Every trade</h3>
      <div className="fee-line"><span>Creator fee<small>Paid by every buy and sell</small></span><strong>{percent(creatorFeeBps)}</strong></div>
      <div className="fee-line"><span>You earn<small>75% of the creator fee, in SOL</small></span><strong>{creatorCut(creatorFeeBps)}</strong></div>
      <div className="fee-line"><span>repo.ing<small>25% of the creator fee</small></span><strong>{platformCut(creatorFeeBps)}</strong></div>
      <div className="fee-line"><span>Max per wallet<small>Until the coin graduates</small></span><strong>{percent(capBps)}</strong></div>
      <div className="fee-note"><Info size={18} aria-hidden="true"/><span>Hooks coins run on repo.ing’s Hook Lab programs, not as standard Solana tokens, so most wallets and explorers won’t list them yet. Buy and sell them on repo.ing.</span></div>
    </div>
  </>
}
