'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Check, Clock3, LoaderCircle } from 'lucide-react'
import { HookWalletSignIn, useHookWalletSession } from './hooklab-wallet-signin'
import { NeuronBotCheck } from './neuron-bot-check'
import { NEURON_DRAFT_KEY, characterPersona } from '../lib/neurons-preview.mjs'
import styles from './neurons-preview.module.css'

export function NeuronPublishAction({ draft, genesisHash, botSiteKey = null, request, onSubmitted, onBusyChange, draftStorageKey = NEURON_DRAFT_KEY }) {
  const session = useHookWalletSession(genesisHash)
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [saved, setSaved] = useState(null)
  const working = useRef(false), botCheck = useRef(null), receipt = useRef(null)
  useEffect(() => { if (saved) receipt.current?.focus() }, [saved])
  async function publish() {
    if (working.current || !consent || !session.signedIn) return
    working.current = true; setBusy(true); onBusyChange?.(true); setError('')
    try {
      const fingerprint = JSON.stringify(draft)
      try { localStorage.setItem(draftStorageKey, fingerprint) } catch {}
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
      if (botSiteKey && !botCheck.current) throw Error('Security check is loading. Please try again.')
      const botToken = botSiteKey ? await botCheck.current() : null
      const response = await fetch('/api/neuron-characters', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(botToken ? { 'x-neuron-bot-token': botToken } : {}) }, body: JSON.stringify({ ...draft, consent: true, requestId: request.current.id }) })
      const value = await response.json()
      if (!response.ok) throw Error(value.error || 'Submission failed. Your draft is saved; try again.')
      setSaved(value.character)
      onSubmitted?.()
      try { if (localStorage.getItem(draftStorageKey) === fingerprint) localStorage.removeItem(draftStorageKey) } catch {}
    } catch (cause) { setError(cause.message || 'Submission failed. Try again.') }
    finally { working.current = false; setBusy(false); onBusyChange?.(false) }
  }
  if (saved) return <section className={styles.submissionReceipt} aria-label="Submission receipt" tabIndex={-1} ref={receipt}>
    <span className={styles.successIcon}><Check size={26}/></span>
    <h3>{saved.status === 'published' ? 'Your character is published.' : 'Your character is in the queue.'}</h3>
    <p>{saved.status === 'published' ? 'Your profile is ready to share.' : draft.personality ? 'Saved to your wallet. A moderator will review your recipe, attribution, and examples before they become public.' : 'Saved to your wallet. A moderator will review the name, story, and attribution before it becomes public.'}</p>
    <ol className={styles.publicationJourney}><li data-complete="true"><Check size={15}/>Created</li><li aria-current={saved.status === 'published' ? undefined : 'step'}><Clock3 size={15}/>{saved.status === 'published' ? 'Reviewed' : 'Awaiting review'}</li><li><Check size={15}/>{saved.status === 'published' ? 'Published' : 'Public profile'}</li></ol>
    <Link className="button primary" href={saved.status === 'published' ? `/neurons/${saved.id}` : '/neurons/mine'}>{saved.status === 'published' ? 'Open public profile' : 'View my characters'} →</Link>
    <small>No token was created. No funds were moved.</small>
  </section>
  return <section className={styles.publishBox} aria-label="Publish character">
    {!draft.personality && <><h3>Make it official.</h3><p>Sign a free message to link this profile to your wallet. No transaction, token, or spending permission.</p></>}
    {draft.personality ? <HookWalletSignIn genesisHash={genesisHash} session={session} title="Claim your character">Sign a free message. No transaction or spending permission.</HookWalletSignIn> : <HookWalletSignIn genesisHash={genesisHash} session={session}/>}
    <label className={styles.checkbox}><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)}/>{draft.personality ? 'I can share this recipe and its examples. After review, they, the attribution, and my creator wallet become public. The recipe is unverified; chat is offline.' : 'I have the right to publish this name and story. After review, the profile and creator wallet will be public, with scripted—not neuron-steered—chat.'}</label>
    <button type="button" className={`button primary ${styles.publishSubmit}`} disabled={!session.signedIn || !consent || busy} onClick={publish}>{busy && <LoaderCircle className={styles.spinner} size={17}/>} {busy ? 'Submitting for review…' : error ? 'Try submission again' : 'Submit for public review'}</button>
    <p className={styles.nextStep} role="status">{busy ? 'Please keep this page open while we save your character.' : !session.signedIn ? 'First, sign in with your wallet above.' : !consent ? 'One last step: confirm your publishing rights above.' : 'Ready. Your profile will stay private while it is reviewed.'}</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <NeuronBotCheck siteKey={botSiteKey} action="neuron-publish" checkRef={botCheck}/>
    <small>Up to 3 submissions per wallet per UTC day; at most 2 awaiting review.</small>
  </section>
}

export function MyNeuronCharacters({ genesisHash }) {
  const session = useHookWalletSession(genesisHash)
  const [characters, setCharacters] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  async function refresh() {
    const current = ++epoch.current
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/neuron-characters?scope=mine', { cache: 'no-store', credentials: 'same-origin' })
      const value = await response.json()
      if (!response.ok) throw Error(value.error || 'Could not load your characters.')
      if (epoch.current === current) setCharacters(value.characters)
    } catch (cause) { if (epoch.current === current) setError(cause.message) }
    finally { if (epoch.current === current) setBusy(false) }
  }
  useEffect(() => {
    setCharacters([]); setError('')
    if (session.signedIn) refresh()
    else { epoch.current += 1; setBusy(false) }
    return () => { epoch.current += 1 }
  }, [session.signedIn, session.identity?.wallet])
  return <main className={styles.main}><Link href="/neurons" className={styles.back}>← Character library</Link>
    <div className={styles.libraryHeading}><div><h1>Your characters.</h1><p>Saved to your wallet identity. Publishing is free; financial execution is off.</p></div><Link className="button primary" href="/neurons/new">Create a Neuro +</Link></div>
    <div className={styles.publishBox}><HookWalletSignIn genesisHash={genesisHash} session={session}/></div>
    {session.signedIn && <><div className={styles.results}><span>Only you can see your pending or rejected submissions.</span><button className="button" disabled={busy} onClick={refresh}>{busy && <LoaderCircle size={15} className={styles.spinner}/>} {busy ? 'Refreshing…' : 'Refresh status'}</button></div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {busy && characters.length === 0 && <div className={styles.loadingState} role="status"><LoaderCircle size={22} className={styles.spinner}/><span>Loading your characters…</span></div>}
      <div className={styles.cardGrid}>{characters.map(character => <article className={styles.submissionCard} key={character.id}>
        <div className={styles.cardTop}><span className={styles.avatar} style={{ '--persona-color': characterPersona(character)?.color }}>{characterPersona(character)?.icon}</span><span className={styles.pill} data-status={character.status}>{character.status === 'pending' ? 'Awaiting review' : character.status === 'published' ? 'Published' : 'Not approved'}</span></div>
        <h2>{character.name} <small>${character.ticker}</small></h2><p>{character.story}</p><small>{character.status === 'pending' ? 'Private until a moderator approves this profile.' : character.status === 'rejected' ? 'Not public. Review the content policy before creating a new submission.' : 'Public profile · no token or trading.'}</small>
        {character.status === 'published' && <Link className="button primary" href={`/neurons/${character.id}`}>Open public profile →</Link>}
        <code title={character.metadataSha256}>SHA-256 {character.metadataSha256.slice(0, 16)}…</code>
      </article>)}</div>
      {!busy && !error && characters.length === 0 && <div className={styles.empty}><h2>A world waiting to begin.</h2><p>Choose a persona and submit your first character for review.</p><Link className="button primary" href="/neurons/new">Create your character</Link></div>}
    </>}
  </main>
}
