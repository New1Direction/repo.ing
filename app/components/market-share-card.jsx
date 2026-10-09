'use client'
import { useEffect, useRef, useState } from 'react'
import { Download, Copy, Image as ImageIcon, X } from 'lucide-react'
import { LoadingSignal } from './loading-signal'
import { ShareReferralNote, useShareReferral } from './share-referral'
import { captionWithReferral } from '../lib/share-links.mjs'

const LABELS = { graduation: 'Graduation progress', payout: 'Latest builder payout' }
const LOADING = { auto: 'Preparing card…', graduation: 'Verifying graduation progress…', payout: 'Verifying payout receipt…' }

// Uncontrolled it renders its own trigger; pass open/onOpenChange to drive it from another control (the share menu).
// The caption's market link carries the wallet's ?ref only under the same rules (and note) as every other share, and never
// for a stock pair (quote: its pair, null for SOL), whose trades carry no referral. Without a signature the route serves the
// first card the market offers and names the ones it offers (src/market-share.mjs shareCardKinds): a tab appears only for a
// card that can work (no graduation progress once a market has graduated). A final refusal (no payout yet, a card the market
// does not offer) is shown without a Retry button.
export function MarketShareCard({ mint, signature = null, quote = null, open: controlledOpen, onOpenChange }) {
  const dialog = useRef(null), request = useRef(null)
  const [innerOpen, setInnerOpen] = useState(false), [kind, setKind] = useState(signature ? 'payout' : 'auto')
  const [kinds, setKinds] = useState(signature ? ['payout'] : null)
  const [card, setCard] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null), [message, setMessage] = useState('')
  const [retry, setRetry] = useState(0)
  const controlled = controlledOpen !== undefined
  const open = controlled ? controlledOpen : innerOpen, setOpen = controlled ? onOpenChange : setInnerOpen
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController(); request.current = controller
    let objectUrl
    setBusy(true); setCard(null); setError(null); setMessage('')
    async function load() {
      try {
        const query = new URLSearchParams({ kind, ...signature ? { signature } : {} })
        const response = await fetch(`/api/market/${encodeURIComponent(mint)}/share-card?${query}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          if (!signature && Array.isArray(body.kinds)) setKinds(body.kinds)
          throw Object.assign(Error(body.error || 'Card unavailable'), { final: Boolean(body.code) })
        }
        const offered = response.headers.get('X-Repoing-Share-Kinds')
        const blob = await response.blob()
        if (controller.signal.aborted) return
        if (!signature && offered !== null) setKinds(offered.split(',').filter(Boolean))
        objectUrl = URL.createObjectURL(blob)
        setCard({ url: objectUrl, blob, kind: response.headers.get('X-Repoing-Share-Kind') || kind, caption: decodeURIComponent(response.headers.get('X-Repoing-Share-Text') || '') })
      } catch (cause) { if (!controller.signal.aborted) setError(cause.name === 'TimeoutError' ? { message: 'Card timed out. Please retry.' } : { message: cause.message, final: cause.final === true }) }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    load()
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [open, mint, signature, kind, retry])
  const referral = useShareReferral(open, !quote)
  const shown = card?.kind ?? (kind === 'auto' ? null : kind)
  const caption = card ? captionWithReferral(card.caption, mint, referral.ref) : ''
  function close() { request.current?.abort(); setOpen(false) }
  async function copy() {
    try { await navigator.clipboard.writeText(caption); setMessage('Caption and proof link copied.') }
    catch { setMessage('Copy unavailable. Select the caption below to copy it.') }
  }
  async function share() {
    const file = new File([card.blob], 'repoing-market.png', { type: 'image/png' })
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: caption })
      else { await copy(); setMessage('Caption copied. Download the PNG to attach to your post.') }
    } catch (cause) { if (cause.name !== 'AbortError') setMessage('Sharing unavailable. Download the PNG and copy the caption instead.') }
  }
  return <>{!controlled && <button type="button" className="button outline" onClick={() => setOpen(true)}><ImageIcon size={15}/>{signature ? 'Payout card' : 'Share card'}</button>}
    <dialog ref={dialog} className="market-share-dialog" aria-labelledby={`share-title-${signature ? 'payout' : 'market'}`} onCancel={close} onClose={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close() } }}>
      <div className="share-dialog-heading"><h2 id={`share-title-${signature ? 'payout' : 'market'}`}>Share this market</h2><button type="button" aria-label="Close share card" onClick={close}><X size={20}/></button></div>
      {!signature && kinds?.length > 1 && <div className="share-card-tabs" aria-label="Card type">{kinds.map(value => <button type="button" key={value} aria-pressed={shown === value} onClick={() => { if (value !== shown) setKind(value) }}>{LABELS[value]}</button>)}</div>}
      <div className="share-card-preview" aria-busy={busy}>{busy ? <p role="status"><LoadingSignal/>{LOADING[kind]}</p> : error ? <div role="status"><p>{error.message}</p>{!error.final && <button type="button" className="button outline" onClick={() => setRetry(v => v + 1)}>Retry</button>}</div> : card ? <img src={card.url} width="1200" height="630" alt={`${card.kind === 'payout' ? (signature ? 'Verified builder payout' : 'Latest verified builder payout') : 'Graduation progress'} share card`}/> : null}</div>
      {card && !busy && <><div className="share-card-actions"><a className="button outline" download={`repoing-${card.kind}.png`} href={card.url}><Download size={15}/>Download PNG</a><button type="button" className="button outline" onClick={copy}><Copy size={15}/>Copy caption</button><button type="button" className="button primary" onClick={share}>Share</button></div><ShareReferralNote referral={referral}/><details className="share-caption"><summary>Caption & proof</summary><p>{caption}</p></details></>}
      <small role="status">{message || 'Cards include a timestamp. Values may change after this snapshot.'}</small>
    </dialog>
  </>
}
