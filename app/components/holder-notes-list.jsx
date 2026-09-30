'use client'
import { useCallback, useEffect, useState } from 'react'
import { useWallet } from './wallet'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { formatAgo } from '../lib/buyback-summary.mjs'
import { NOTE_MAX, holdingLabel, shortWallet } from '../lib/holder-note-format.mjs'

async function call(url, init) {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Notes are temporarily unavailable.')
  return result
}
const post = (url, body) => call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const merge = (current, next) => [...current, ...next.filter(n => !current.some(c => c.id === n.id))]

function Note({ note, symbol }) {
  return <li className="holder-note">
    <p className="holder-note-body">{note.body}</p>
    <p className="holder-note-meta"><span className="holder-note-wallet" title={note.wallet}>{shortWallet(note.wallet)}</span>
      <span className={note.sold ? 'holder-note-hold is-sold' : 'holder-note-hold'}>{note.sold ? 'sold' : `holds ${holdingLabel(note.balance)} $${symbol}`}</span>
      <time dateTime={note.updatedAt} suppressHydrationWarning>{formatAgo(note.updatedAt)}</time></p>
  </li>
}

// Public list (server-rendered first page) plus the signed composer for the connected wallet.
export function HolderNotesList({ mint, symbol, initial }) {
  const { wallet, provider, connect } = useWallet()
  const [notes, setNotes] = useState(initial.notes), [hasMore, setHasMore] = useState(initial.hasMore)
  const [own, setOwn] = useState(null), [open, setOpen] = useState(false), [text, setText] = useState('')
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const base = `/api/holder-notes/${mint}`

  useEffect(() => {
    let active = true
    setOwn(null); setOpen(false)
    if (wallet) call(`${base}?wallet=${encodeURIComponent(wallet)}`).then(r => { if (active) setOwn(r.note) }).catch(() => {})
    return () => { active = false }
  }, [base, wallet])

  const reload = useCallback(async () => {
    const page = await call(`${base}?offset=0`)
    setNotes(page.notes); setHasMore(page.hasMore)
  }, [base])

  async function more() {
    setBusy('more'); setError('')
    try { const page = await call(`${base}?offset=${notes.length}`); setNotes(current => merge(current, page.notes)); setHasMore(page.hasMore) }
    catch (cause) { setError(cause.message) } finally { setBusy('') }
  }

  async function sign(intent) {
    if (busy) return
    setBusy(intent); setError(''); setNotice('')
    try {
      const challenge = await post(base, { action: 'challenge', intent, wallet, text: intent === 'post' ? text : undefined })
      setNotice('Approve the message in your wallet. It does not send a transaction.')
      const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(challenge.message)))
      const result = await post(base, { action: 'submit', challenge: challenge.challenge, signature: btoa(String.fromCharCode(...signature)), text: intent === 'post' ? text : undefined })
      setOwn(result.note ?? null); setOpen(false)
      setNotice(intent === 'delete' ? 'Your note was deleted.' : result.note?.hidden ? 'Saved. A moderator has hidden your note from the public list.' : 'Your note is live.')
      await reload()
    } catch (cause) { setError(cause.message || 'Your note could not be saved.'); setNotice('') }
    finally { setBusy('') }
  }

  function toggle() {
    if (!wallet) { void connect(); return }
    setOpen(value => !value); setText(own?.body ?? ''); setError(''); setNotice('')
  }

  const length = [...text].length
  return <>
    <div className="holder-notes-heading"><h3 id="holder-notes-title">Why holders bought</h3>
      <button type="button" className="holder-notes-add" aria-expanded={open} aria-controls="holder-note-form" onClick={toggle}>
        {!wallet ? 'Connect to add yours' : own ? 'Edit your note' : 'Add your note'}</button></div>
    {open && <form id="holder-note-form" className="holder-note-form" onSubmit={event => { event.preventDefault(); void sign('post') }}>
      <label htmlFor="holder-note-text" className="sr-only">Why you bought ${symbol}</label>
      <textarea id="holder-note-text" value={text} maxLength={NOTE_MAX * 2} rows={3} placeholder={`Why did you buy $${symbol}?`} onChange={event => setText(event.target.value)} disabled={Boolean(busy)}/>
      <div className="holder-note-form-row"><small className={length > NOTE_MAX ? 'is-over' : ''} aria-live="polite">{length}/{NOTE_MAX}</small>
        {own && <button type="button" className="holder-note-delete" disabled={Boolean(busy)} onClick={() => { void sign('delete') }}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>}
        <button type="submit" className="button primary" disabled={Boolean(busy) || !text.trim() || length > NOTE_MAX}>{busy === 'post' ? 'Signing…' : own ? 'Update note' : 'Post note'}</button></div>
      <p className="holder-note-fineprint">Holders who bought here can post one note. Plain text, links only to github.com. Signing is free.</p>
    </form>}
    {notice && <p className="transaction-status" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notes.length ? <ol className="holder-notes-list">{notes.map(note => <Note key={note.id} note={note} symbol={symbol}/>)}</ol>
      : <p className="holder-notes-empty">{initial.unavailable ? 'Notes are temporarily unavailable.' : `No notes yet. Bought $${symbol} here? Share why.`}</p>}
    {hasMore && <button type="button" className="holder-notes-more" disabled={busy === 'more'} onClick={() => { void more() }}>{busy === 'more' ? 'Loading…' : 'Show more'}</button>}
  </>
}
