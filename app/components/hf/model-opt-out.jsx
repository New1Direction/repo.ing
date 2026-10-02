'use client'
import Link from 'next/link'
import { useCallback, useEffect, useId, useState } from 'react'
import { Ban, Check, Search } from 'lucide-react'
import { HF_DISCLAIMER } from '../../../src/hf-copy.mjs'
import { hfModelUrl } from '../../../src/hf-url.mjs'
import '../../maintainer-opt-out.css'
import styles from './model-authority.module.css'

// /opt-out, Hugging Face models: the owner of a public model, or an admin of the organization that owns it, signs in with
// Hugging Face, looks the model up by URL, and declines its market or opts it out of repo.ing (no launches). The server
// checks the model's current owner on Hugging Face again before any change (app/api/opt-out/hf/route.js).
const NOTE_LIMIT = 280
const ERRORS = { 'hf-unavailable': 'Hugging Face sign-in is unavailable right now. Try again later.', 'hf-denied': 'Hugging Face sign-in was cancelled.',
  'hf-sign-in-failed': 'Hugging Face sign-in could not finish. Please try again.' }
const dayLabel = value => new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
// Sign in again for this model; an organization's _id asks Hugging Face to offer sharing that organization.
const signInFor = model => `/api/hf/start?mode=models&model=${encodeURIComponent(model.path)}${model.owner.kind === 'org' && /^[0-9a-f]{24}$/.test(model.owner.id ?? '') ? `&org=${model.owner.id}` : ''}`

async function request(url, init) {
  const response = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(45_000) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error || 'This could not be checked. Try again.'), { status: response.status })
  return body
}

function ModelDecision({ found, onChanged }) {
  const id = useId()
  const [open, setOpen] = useState(false), [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [done, setDone] = useState('')
  const { live, decision } = found, path = found.model.path
  const noteLength = [...note.trim()].length
  const word = live ? 'decline' : 'opt-out'
  async function submit(action) {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await request('/api/opt-out/hf', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, model: path, hfId: found.model.hfId, ...(action === 'withdraw' ? {} : { note }) }) })
      setOpen(false); setNote('')
      setDone(action === 'withdraw' ? `Your ${word} is withdrawn.` : live ? 'Market declined. Its token page now shows your decision.' : 'Opted out. Nobody can launch it on repo.ing.')
      onChanged({ ...found, decision: result.decision, marketId: result.marketId ?? found.marketId })
    } catch (cause) { setError(cause.name === 'TimeoutError' ? 'Hugging Face took too long to answer. Try again.' : cause.message) }
    finally { setBusy(false) }
  }
  return <section className={`maintainer-decision inner-card${decision ? ' is-active' : ''}`} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{decision ? (live ? 'Market declined by the owner' : 'Opted out of repo.ing') : live ? 'Don’t want this market?' : 'Opt out of repo.ing'}</h3>
    {decision ? <p className="decision-state"><Ban size={15} aria-hidden="true"/><span>{live ? 'Declined' : 'Opted out'} by a verified Hugging Face owner
      on <time dateTime={decision.createdAt}>{dayLabel(decision.createdAt)}</time>{decision.note && <> · <q>{decision.note}</q></>}</span></p>
      : <p className="decision-lead">{live ? `You can decline the ${path} market. It keeps trading so holders can exit, but repo.ing stops promoting it and says its owner declined it.`
        : `You can opt ${path} out so nobody can launch a market for it on repo.ing.`}</p>}
    <button type="button" className={`decision-trigger${decision ? '' : ' is-decline'}`} aria-expanded={open} aria-controls={`${id}-panel`}
      onClick={() => { if (!busy) { setOpen(!open); setError(''); setDone('') } }}>{decision ? `Withdraw ${word}` : live ? 'Decline this market' : 'Opt out of repo.ing'}</button>
    {open && <div id={`${id}-panel`} className="decision-confirm">
      {decision ? <>
        <p className="decision-confirm-title">Withdraw your {word}?</p>
        <p className="decision-confirm-copy">{live ? 'The banner comes off the token page and repo.ing may feature this market again.' : `Anyone can launch a market for ${path} on repo.ing again.`}</p>
        <div className="decision-actions">
          <button type="button" className="button outline" disabled={busy} onClick={() => submit('withdraw')}>{busy ? 'Checking Hugging Face…' : `Withdraw ${word}`}</button>
          <button type="button" className="button outline" disabled={busy} onClick={() => setOpen(false)}>Keep it</button>
        </div>
      </> : <>
        <p className="decision-confirm-title">{live ? `Decline the ${path} market?` : `Opt ${path} out of repo.ing?`}</p>
        <ul className="decision-effects">{live ? <>
          <li><strong>Hidden from promotion.</strong> repo.ing stops featuring it in lists, alerts and launch suggestions.</li>
          <li><strong>Banner shown.</strong> Its token page says the model’s owner declined this market and that it is not endorsed by them.</li>
          <li><strong>Trading continues.</strong> The market stays open so holders can exit.</li>
          <li><strong>Fees stay claimable.</strong> Fees keep accruing for the model’s current owner and stay claimable as now.</li>
        </> : <>
          <li><strong>No launches.</strong> Nobody can launch a market for {path} on repo.ing.</li>
          <li><strong>Never promoted.</strong> repo.ing never suggests or features it.</li>
          <li><strong>Reversible.</strong> You can withdraw the opt-out at any time.</li>
        </>}</ul>
        <label className="decision-note-label" htmlFor={`${id}-note`}>Public note <span>optional</span></label>
        <textarea id={`${id}-note`} value={note} disabled={busy} rows={3} aria-describedby={`${id}-note-help`} onChange={event => setNote(event.target.value)}
          placeholder={live ? 'Why you declined, in your own words' : 'Shown if someone tries to launch it'}/>
        <div id={`${id}-note-help`} className="decision-note-help"><span>Plain text, shown publicly.</span>
          <span className={noteLength > NOTE_LIMIT ? 'is-over' : undefined}>{noteLength}/{NOTE_LIMIT}</span></div>
        <div className="decision-actions">
          <button type="button" className="button decline" disabled={busy || noteLength > NOTE_LIMIT} onClick={() => submit(live ? 'decline' : 'opt_out')}>
            {busy ? 'Checking Hugging Face…' : live ? 'Decline this market' : 'Opt out'}</button>
          <button type="button" className="button outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </>}
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {done && <p className="decision-done" role="status"><Check size={15} aria-hidden="true"/>{done}</p>}
  </section>
}

export function ModelOptOut({ signedIn, initialModel = null, errorCode = null }) {
  const [query, setQuery] = useState(initialModel ?? ''), [found, setFound] = useState(null), [loading, setLoading] = useState(false)
  const [error, setError] = useState(errorCode && Object.hasOwn(ERRORS, errorCode) ? ERRORS[errorCode] : ''), [needsLogin, setNeedsLogin] = useState(!signedIn)
  const lookup = useCallback(async value => {
    if (!value.trim()) return
    setLoading(true); setError(''); setFound(null)
    try { setFound(await request(`/api/opt-out/hf?model=${encodeURIComponent(value.trim())}`)) }
    catch (cause) { if (cause.status === 401) setNeedsLogin(true); else setError(cause.name === 'TimeoutError' ? 'Hugging Face took too long to answer. Try again.' : cause.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { if (signedIn && initialModel) void lookup(initialModel) }, [signedIn, initialModel, lookup])
  const signIn = `/api/hf/start?mode=models${query.trim() && /^[\w.-]+\/[\w.-]+$/.test(query.trim()) ? `&model=${encodeURIComponent(query.trim())}` : ''}`

  return <section id="models" className={`opt-out-signin inner-card ${styles.section}`} aria-labelledby="model-opt-out-title">
    <h2 id="model-opt-out-title">Hugging Face models</h2>
    <p>Anyone can launch a market for a public Hugging Face model on repo.ing. If you own one, or administer the organization that owns it, you can decline its market or opt it out.</p>
    <p className="decision-hint">{HF_DISCLAIMER}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {needsLogin ? <><a className="button primary" href={signIn}>Sign in with Hugging Face</a>
      <small>Signing in only tells repo.ing who you are and which organizations you share with it. It grants no access to your models.</small></> : <>
      <p className="opt-out-account"><span>Signed in to Hugging Face as {signedIn?.username}</span><a href={signIn}>Switch account</a></p>
      <form className={styles.search} role="search" onSubmit={event => { event.preventDefault(); void lookup(query) }}>
        <label className="opt-out-search"><Search size={16} aria-hidden="true"/>
          <input type="search" aria-label="Hugging Face model URL or owner/name" placeholder="huggingface.co/owner/name" value={query} maxLength={300}
            autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={event => setQuery(event.target.value)}/></label>
        <button type="submit" className="button outline" disabled={loading || !query.trim()}>{loading ? 'Checking…' : 'Look up'}</button>
      </form>
      <div aria-live="polite" aria-busy={loading || undefined}>{loading && <p className="decision-hint">Checking the model on Hugging Face…</p>}
      {found && <div className={`opt-out-repo ${styles.found}`}>
        <div className="opt-out-repo-name"><a href={hfModelUrl(found.model.path)} target="_blank" rel="noopener noreferrer">{found.model.path}</a>
          <small>Owned by {found.model.owner.handle} ({found.model.owner.kind === 'org' ? 'organization' : 'user'}) · {found.mint ? <>Has a market · <Link href={`/token/${found.mint}`}>View it</Link></> : 'No market on repo.ing'}</small></div>
        {found.authority.authorized ? <ModelDecision key={found.model.hfId} found={found} onChanged={setFound}/>
          : <p className="decision-hint">{found.authority.message}{found.model.owner.kind === 'org' && <> <a href={signInFor(found.model)}>Sign in again</a></>}</p>}
      </div>}</div>
    </>}
  </section>
}
