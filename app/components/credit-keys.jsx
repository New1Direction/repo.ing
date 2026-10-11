'use client'
import { Fragment, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { money } from './credit-packs/packs-model.mjs'
import { DEFAULT_LABEL, LABEL_PATTERN, MIN_LIMIT_MICRO, STATE_NAMES, dayOf, settingLines, usdText, usdToMicro } from './credit-keys-model.mjs'

// "Your AI credits" on /credits (src/credits-keys.mjs, app/api/credits/keys/route.js): the balance, the keys and a form that
// makes one inference-only key for a coding tool. A new key's token comes back once, in the answer to the click. It lives
// only in this component's state: it is not stored, not put in the address, and gone when the key is hidden or the page reloads.
const NAME_HELP = '1 to 64 letters, digits, spaces, dots, dashes or underscores. Start with a letter or digit.'
const STEPS = ['Make a key here and copy its two lines.', 'Paste them into the settings of Cursor, Claude Code or any tool that speaks the OpenAI API.',
  'The tool runs AI models and spends your credits. It cannot buy credits or make keys.']
const dollars = micro => micro === null || micro === undefined ? '?' : money(micro)
// How much of its limit a key has spent, 0 to 1 (an unknown figure reads as nothing).
const used = key => key.budgetMicro > 0 && key.spentMicro !== null ? Math.min(1, key.spentMicro / key.budgetMicro) : 0
// A line that may break after a slash or a dot, so an address wraps at its parts and not in the middle of a word.
const breakable = text => text.split(/(?<=[/.])/).map((part, index) => <Fragment key={index}>{index > 0 && <wbr/>}{part}</Fragment>)

async function call(method, body) {
  const response = await fetch('/api/credits/keys', method === 'GET' ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw Error(result.error || 'Your AI credits are not available right now.')
  return result
}

export function CreditKeys() {
  const [data, setData] = useState({ state: 'loading', baseUrl: '', availableMicro: 0, keys: [] })
  const [fresh, setFresh] = useState(null)
  const [name, setName] = useState(DEFAULT_LABEL), [limit, setLimit] = useState(null)
  // What is running and the last error, each with the place on the page it belongs to: 'top', 'make' (the form) or 'keys' (the list).
  const [busy, setBusy] = useState(null), [error, setError] = useState(null), [confirming, setConfirming] = useState('')
  const [copied, setCopied] = useState(''), [copyFailed, setCopyFailed] = useState(false)
  const timer = useRef(null), freshRef = useRef(null)

  const overview = value => setData(current => ({ ...current, state: value.needsSignIn ? 'signin' : 'ready', availableMicro: value.availableMicro ?? 0, keys: value.keys ?? [] }))
  async function load() {
    const result = await call('GET')
    if (!result.signedIn) throw Error('Sign in with GitHub to see your AI credits.')
    setData({ state: result.needsSignIn ? 'signin' : 'ready', baseUrl: result.baseUrl, availableMicro: result.availableMicro ?? 0, keys: result.keys ?? [] })
  }
  // The first read, and "Try again" after one that failed.
  const open = () => {
    setError(null); setData(current => ({ ...current, state: 'loading' }))
    return load().catch(e => { setError({ where: 'top', text: e.message }); setData(current => ({ ...current, state: 'failed' })) })
  }
  useEffect(() => { open(); return () => clearTimeout(timer.current) }, [])
  // Leaving the page drops the key at once (flushed, so the browser's back-forward cache cannot freeze the page with it on screen).
  useEffect(() => {
    const drop = () => flushSync(() => { setFresh(null); setCopied(''); setCopyFailed(false) })
    window.addEventListener('pagehide', drop)
    return () => window.removeEventListener('pagehide', drop)
  }, [])
  // The new key is the thing to read next: bring it into view and move focus to it.
  useEffect(() => {
    if (!fresh || !freshRef.current) return
    freshRef.current.focus({ preventScroll: true })
    freshRef.current.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [fresh])

  async function run(where, text, task) {
    setError(null); setBusy({ where, text })
    try { await task() } catch (e) { setError({ where, text: e.message }) } finally { setBusy(null) }
  }
  const show = () => run('top', 'Signing you in to AI credits…', async () => overview(await call('POST', { action: 'check' })))
  function make(event) {
    event.preventDefault()
    if (!canMake) return
    setConfirming('')
    return run('make', 'Making your key…', async () => {
      try {
        const result = await call('POST', { action: 'make', label: name, ...limit === null ? {} : { limitMicro: String(limitMicro) } })
        setFresh({ key: result.key, token: result.token, baseUrl: result.baseUrl })
        setLimit(null)
      } finally { await load().catch(() => {}) }
    })
  }
  const revoke = id => { setConfirming(''); return run('keys', 'Revoking the key…', async () => {
    const result = await call('POST', { action: 'revoke', keyId: id })
    if (result.overview) overview(result.overview); else await load()
  }) }
  async function copy(id, line) {
    try {
      await navigator.clipboard.writeText(line)
      setCopyFailed(false); setCopied(id)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(''), 2000)
    } catch { setCopyFailed(true) }
  }
  const ready = data.state === 'ready'
  // An error belongs where the click was; with no form or list on the page (the reload after a failed click found no session), at the top.
  const status = where => <>
    {busy?.where === where && <p className="claim-progress" role="status"><span className="claim-spinner" aria-hidden="true"/>{busy.text}</p>}
    {error && (error.where === where || (where === 'top' && !ready)) && <p className="inline-error" role="alert">{error.text}</p>}
  </>

  const available = data.availableMicro, hasCredits = available >= MIN_LIMIT_MICRO, working = Boolean(busy)
  const limitMicro = limit === null ? available : usdToMicro(limit)
  const nameError = LABEL_PATTERN.test(name) ? '' : NAME_HELP
  const limitError = limit === null ? '' : limitMicro === null ? 'Enter $0.01 or more, like 20 or 20.50.'
    : limitMicro > available ? `At most ${money(available)}, the credits you have.` : ''
  const canMake = ready && hasCredits && !nameError && !limitError && !working

  return <section className="credit-keys" id="keys" aria-labelledby="keys-heading" aria-busy={working}>
    <header className="keys-head">
      <div>
        <div className="eyebrow">YOUR AI CREDITS</div>
        <h2 id="keys-heading">Take your credits to work.</h2>
        <p>Make a key and paste two lines into your coding tool. The key spends your credits on AI models, and nothing else.</p>
      </div>
      {ready && <div className="keys-balance"><span>AI credits available</span><b>{money(available)}</b></div>}
    </header>
    {data.state === 'loading' && <p role="status" className="keys-quiet">Checking your AI credits…</p>}
    {data.state === 'failed' && <div className="keys-quiet"><p className="inline-error" role="alert">{error?.text || 'Your AI credits could not be read.'}</p>
      <button type="button" className="button outline" onClick={open}>Try again</button></div>}
    {data.state === 'signin' && <div className="keys-panel keys-signin">
      <h3>Show your credits and keys</h3>
      <p>This signs you in to AI credits with your GitHub account. It only reads your credits and keys.</p>
      <button type="button" className="button primary" disabled={working} onClick={show}>Show my AI credits</button>
      {status('top')}
    </div>}
    {ready && <>
      <div className="keys-grid">
        <form className="keys-panel keys-make" onSubmit={make} noValidate>
          <h3>Make a key</h3>
          {!hasCredits && <p className="keys-note">You have no AI credits yet. Open a pack above first.</p>}
          <label htmlFor="keys-name">Name</label>
          <input id="keys-name" value={name} onChange={e => setName(e.target.value)} maxLength={64} autoComplete="off" spellCheck={false}
            aria-invalid={Boolean(nameError)} aria-describedby="keys-name-help" disabled={!hasCredits || working}/>
          <small id="keys-name-help" className={nameError ? 'is-error' : ''}>{nameError || 'Like the tool or the computer.'}</small>
          <label htmlFor="keys-limit">Spending limit in USD</label>
          <div className="keys-money"><span aria-hidden="true">$</span>
            <input id="keys-limit" inputMode="decimal" value={limit ?? (hasCredits ? usdText(available) : '')} onChange={e => setLimit(e.target.value)} autoComplete="off"
              aria-invalid={Boolean(limitError)} aria-describedby="keys-limit-help" disabled={!hasCredits || working}/></div>
          <small id="keys-limit-help" className={limitError ? 'is-error' : ''}>{limitError || (hasCredits ? `Up to ${money(available)}, all your credits. At least $0.01.` : 'Needs credits first.')}</small>
          <button type="submit" className="button primary" disabled={!canMake}>Make a key</button>
          {status('make')}
        </form>
        {fresh ? <div className="keys-panel keys-fresh" ref={freshRef} tabIndex={-1} role="region" aria-labelledby="keys-fresh-heading">
          <h3 id="keys-fresh-heading">Your key “{fresh.key.label}” is ready</h3>
          <p><strong>This is the only time you will see it.</strong> Copy both lines into your coding tool’s settings.</p>
          {settingLines(fresh.baseUrl, fresh.token).map(({ variable, value, line }) => <div className="keys-line" key={variable}>
            <code><span>{variable}</span>={variable === 'OPENAI_BASE_URL' ? breakable(value) : value}</code>
            <button type="button" className="button outline" onClick={() => copy(variable, line)} aria-label={`Copy the ${variable} line`}>{copied === variable ? 'Copied' : 'Copy'}</button>
          </div>)}
          <span className="sr-only" role="status">{copied ? 'Copied to the clipboard.' : ''}</span>
          {copyFailed && <p className="keys-note is-error" role="alert">Your browser did not copy it. Select the line and copy it by hand.</p>}
          <p className="keys-note">Limit {dollars(fresh.key.budgetMicro)} · valid until {dayOf(fresh.key.expiresAt)} · inference only. If it leaks, revoke it below.</p>
          <button type="button" className="button outline" onClick={() => { setFresh(null); setCopied(''); setCopyFailed(false) }}>I saved it. Hide the key.</button>
        </div> : <div className="keys-panel keys-steps">
          <h3>How it works</h3>
          <ol>{STEPS.map(step => <li key={step}>{step}</li>)}</ol>
        </div>}
      </div>
      <div className="keys-panel keys-list-panel">
        <h3>Your keys</h3>
        {data.keys.length === 0 ? <p className="keys-note">No keys yet.{hasCredits ? ' Make your first one above.' : ''}</p> : <ul className="keys-list">
          {data.keys.map(key => <li key={key.id} className={`key-row is-${key.state}`}>
            <div className="key-name"><strong>{key.label}</strong><span>#{key.id.slice(0, 8)}</span></div>
            <span className="key-state">{STATE_NAMES[key.state]}</span>
            <div className="key-spend">
              <span className="key-meter" aria-hidden="true"><i style={{ transform: `scaleX(${used(key)})` }}/></span>
              <span>{dollars(key.spentMicro)} of {dollars(key.budgetMicro)} spent</span>
            </div>
            <span className="key-until">{key.state === 'live' ? 'Valid until' : key.state === 'expired' ? 'Expired' : 'Was valid until'} <time dateTime={key.expiresAt ?? undefined}>{dayOf(key.expiresAt)}</time></span>
            <div className="key-actions">{key.state === 'live' && (confirming === key.id ? <>
              <button type="button" key="yes" className="button danger" disabled={working} onClick={() => revoke(key.id)}>Yes, revoke</button>
              {/* The safe answer has the focus, so a second Enter keeps the key. */}
              <button type="button" key="keep" className="claim-text-button" autoFocus onClick={() => setConfirming('')}>Keep</button>
            </> : <button type="button" key="revoke" className="button outline" disabled={working} aria-label={`Revoke the key ${key.label}`} onClick={() => setConfirming(key.id)}>Revoke</button>)}</div>
          </li>)}
        </ul>}
        {status('keys')}
      </div>
    </>}
  </section>
}
