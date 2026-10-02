'use client'
import { useEffect, useRef, useState } from 'react'
import { Download, Copy, Image as ImageIcon, X } from 'lucide-react'
import { LoadingSignal } from './loading-signal'
import { useWallet } from './wallet'
import { captionWithReferral } from '../lib/share-links.mjs'

// Uncontrolled it renders its own trigger; pass open/onOpenChange to drive it from another control (the share menu).
// A connected wallet's caption links the market with its own ?ref.
export function MarketShareCard({ mint, signature = null, open: controlledOpen, onOpenChange }) {
  const { wallet } = useWallet() ?? {}
  const dialog = useRef(null), request = useRef(null)
  const [innerOpen, setInnerOpen] = useState(false), [kind, setKind] = useState(signature ? 'payout' : 'graduation')
  const [card, setCard] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [retry, setRetry] = useState(0)
  const controlled = controlledOpen !== undefined
  const open = controlled ? controlledOpen : innerOpen, setOpen = controlled ? onOpenChange : setInnerOpen
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController(); request.current = controller
    let objectUrl
    setBusy(true); setCard(null); setError(''); setMessage('')
    async function load() {
      try {
        const url = `/api/market/${encodeURIComponent(mint)}/share-card?kind=${kind}${signature ? `&signature=${encodeURIComponent(signature)}` : ''}`
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
        if (!response.ok) throw Error((await response.json()).error || 'Card unavailable')
        const blob = await response.blob()
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setCard({ url: objectUrl, blob, caption: decodeURIComponent(response.headers.get('X-Repoing-Share-Text') || '') })
      } catch (cause) { if (!controller.signal.aborted) setError(cause.name === 'TimeoutError' ? 'Card timed out. Please retry.' : cause.message) }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    load()
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [open, mint, signature, kind, retry])
  const caption = card ? captionWithReferral(card.caption, mint, wallet) : ''
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
  return <>{!controlled && <button type="button" className="button outline" onClick={() => setOpen(true)}><ImageIcon size={15}/>{signature ? 'Share payout' : 'Share card'}</button>}
    <dialog ref={dialog} className="market-share-dialog" aria-labelledby={`share-title-${signature ? 'payout' : 'market'}`} onCancel={close} onClose={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close() } }}>
      <div className="share-dialog-heading"><h2 id={`share-title-${signature ? 'payout' : 'market'}`}>Share this market</h2><button type="button" aria-label="Close share card" onClick={close}><X size={20}/></button></div>
      {!signature && <div className="share-card-tabs" aria-label="Card type">{[['graduation', 'Graduation progress'], ['payout', 'Builder payout']].map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div>}
      <div className="share-card-preview" aria-busy={busy}>{busy ? <p role="status"><LoadingSignal/>Verifying {kind === 'payout' ? 'payout receipt' : 'graduation progress'}…</p> : error ? <div role="status"><p>{error}</p><button type="button" className="button outline" onClick={() => setRetry(v => v + 1)}>Retry</button></div> : card ? <img src={card.url} width="1200" height="630" alt={`${kind === 'payout' ? 'Verified builder payout' : 'Graduation progress'} share card`}/> : null}</div>
      {card && !busy && <><div className="share-card-actions"><a className="button outline" download={`repoing-${kind}.png`} href={card.url}><Download size={15}/>Download PNG</a><button type="button" className="button outline" onClick={copy}><Copy size={15}/>Copy caption</button><button type="button" className="button primary" onClick={share}>Share</button></div><details className="share-caption"><summary>Caption & proof</summary><p>{caption}</p></details></>}
      <small role="status">{message || 'Cards include a timestamp. Values may change after this snapshot.'}</small>
    </dialog>
  </>
}
