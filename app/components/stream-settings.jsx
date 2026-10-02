'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { RadioTower } from 'lucide-react'
import styles from './builder-kit.module.css'

const API = '/api/builders/stream'
const FAILED = 'Stream settings could not be saved. Refresh and try again.'

// A verified admin's stream link and "Live now" switch. The server re-checks GitHub admin access before every change;
// live turns itself off six hours after it is switched on. `initial` (server-read) skips the first fetch: null means
// no link yet, undefined means unknown.
export function StreamSettings({ repoId, initial }) {
  const [stream, setStream] = useState(initial)
  const [url, setUrl] = useState(initial?.url ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('')
  const [now, setNow] = useState(null), [until, setUntil] = useState('')
  const pending = useRef(false), id = useId()
  const liveUntil = stream?.liveUntil ? Date.parse(stream.liveUntil) : null
  const live = Boolean(stream?.live && (now === null || liveUntil > now))

  useEffect(() => {
    if (initial !== undefined) return
    let active = true
    fetch(`${API}?repo=${encodeURIComponent(repoId)}`, { cache: 'no-store' })
      .then(async response => { const body = await response.json(); if (!response.ok) throw Error(body.error); return body.stream })
      .then(value => { if (active) { setStream(value); setUrl(value?.url ?? '') } })
      .catch(cause => { if (active) { setStream(null); setError(cause.message || 'Stream settings are unavailable.') } })
    return () => { active = false }
  }, [repoId, initial])
  // Times are formatted after mount (viewer's clock and zone), and the switch flips off when the window ends.
  useEffect(() => {
    setNow(Date.now())
    if (!liveUntil) { setUntil(''); return }
    setUntil(new Date(liveUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(liveUntil - Date.now() + 500, 2 ** 31 - 1)))
    return () => clearTimeout(timer)
  }, [liveUntil])

  async function send(body, done) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setStatus('')
    try {
      const response = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoId, ...body }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw Error(result.error || FAILED)
      setStream(result.stream); setUrl(result.stream?.url ?? ''); setStatus(done(result.stream))
    } catch (cause) { setError(cause.message || FAILED) }
    finally { pending.current = false; setBusy(false) }
  }
  const save = event => { event.preventDefault(); void send({ action: 'save', url }, () => 'Stream link saved. It shows on your token page.') }
  const toggle = () => send({ action: 'live', live: !live }, value => value?.live ? 'You are live. The token page shows a LIVE badge.' : 'Live is off.')
  const remove = () => send({ action: 'remove' }, () => 'Stream link removed.')

  return <form className={styles.stream} onSubmit={save} aria-busy={busy || stream === undefined}>
    <h3 className={styles.streamHead}><RadioTower size={17} aria-hidden="true"/>Live building stream{live && <span className={styles.liveBadge}>LIVE</span>}</h3>
    <label className={styles.field} htmlFor={`${id}-url`}>Stream link</label>
    <div className={styles.inputRow}><input id={`${id}-url`} type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={300}
      placeholder="https://twitch.tv/yourname" value={url} disabled={busy || stream === undefined} onChange={event => setUrl(event.target.value)}
      aria-describedby={`${id}-hint`} required/>
      <button type="submit" className="button outline" disabled={busy || stream === undefined || !url.trim() || url.trim() === stream?.url}>{stream ? 'Update' : 'Save'}</button></div>
    <p id={`${id}-hint`} className={styles.hint}>YouTube, Twitch, X or Kick. Your token page shows a Watch link to it; nothing is embedded.</p>
    {stream && <div className={styles.liveRow}>
      <button type="button" role="switch" aria-checked={live} className={styles.switch} disabled={busy} onClick={toggle}><span className={styles.track} aria-hidden="true"/>Live now</button>
      <span className={styles.liveNote}>{live ? until ? `Live until ${until}. Turns off by itself.` : 'Live. Turns off by itself.' : 'Turns off by itself after 6 hours.'}</span>
      <button type="button" className={styles.textButton} disabled={busy} onClick={remove}>Remove link</button>
    </div>}
    {error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.status} role="status">{status}</p>}
  </form>
}
