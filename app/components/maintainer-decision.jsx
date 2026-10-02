'use client'
import { useId, useRef, useState } from 'react'
import { Ban, Check } from 'lucide-react'
import '../maintainer-opt-out.css'

const NOTE_LIMIT = 280
const dayLabel = value => new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })

async function postDecision(body) {
  const response = await fetch('/api/opt-out', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'This could not be saved. Refresh and try again.')
  return result
}

// Exactly what the server applies (src/maintainer-opt-outs.mjs), stated before the maintainer confirms.
function Effects({ live, fullName }) {
  return live ? <ul className="decision-effects">
    <li><strong>Hidden from promotion.</strong> repo.ing stops featuring it: home lists, graduation race, Dev Pulse, alerts and launch suggestions.</li>
    <li><strong>Banner shown.</strong> Its token page says the maintainer of {fullName} has declined this market and that it is not endorsed by the project.</li>
    <li><strong>Trading continues.</strong> The market stays open so holders can exit.</li>
    <li><strong>Your fees stay claimable.</strong> Builder fees keep accruing and stay claimable by you, exactly as now.</li>
  </ul> : <ul className="decision-effects">
    <li><strong>No launches.</strong> Nobody can launch a market for {fullName} on repo.ing.</li>
    <li><strong>Never promoted.</strong> repo.ing never suggests or features it.</li>
    <li><strong>Reversible.</strong> You can withdraw the opt-out at any time.</li>
  </ul>
}

// Decline a repository's market (live) or opt a repository without one out of repo.ing, and withdraw either. The server
// re-checks current GitHub admin access on every change; canAct only decides whether the controls are offered.
export function MaintainerDecision({ repoId, fullName, live, decision: initial = null, canAct = true, compact = false }) {
  const id = useId(), trigger = useRef(null)
  const [decision, setDecision] = useState(initial)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('')
  const noteLength = [...note.trim()].length
  const word = live ? 'decline' : 'opt-out'
  const panelId = `${id}-panel`

  function toggle(next) { setOpen(next); setError(''); setDone(''); if (!next) trigger.current?.focus() }
  async function submit(action) {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await postDecision({ action, repoId, ...(action === 'withdraw' ? {} : { note }) })
      setDecision(result.decision); setOpen(false); setNote('')
      setDone(action === 'withdraw' ? `Your ${word} is withdrawn.` : live ? 'Market declined. Its token page now shows your decision.' : 'Opted out. Nobody can launch it on repo.ing.')
      trigger.current?.focus()
    } catch (cause) { setError(cause.name === 'TimeoutError' ? 'GitHub took too long to answer. Try again.' : cause.message) }
    finally { setBusy(false) }
  }

  const title = decision ? (live ? 'Market declined by the maintainer' : 'Opted out of repo.ing') : live ? 'Don’t want this market?' : 'Opt out of repo.ing'
  return <section className={`maintainer-decision${compact ? ' compact' : ' inner-card'}${decision ? ' is-active' : ''}`}
    {...compact ? { 'aria-label': `${fullName}: ${title}` } : { 'aria-labelledby': `${id}-title` }}>
    {!compact && <h3 id={`${id}-title`}>{title}</h3>}
    {decision ? <p className="decision-state"><Ban size={15} aria-hidden="true"/><span>{live ? 'Declined' : 'Opted out'} by a verified GitHub admin
      on <time dateTime={decision.createdAt}>{dayLabel(decision.createdAt)}</time>{decision.note && <> · <q>{decision.note}</q></>}</span></p>
      : !compact && <p className="decision-lead">{live ? `A current GitHub admin of ${fullName} can decline its market. It keeps trading so holders can exit, but repo.ing stops promoting it and says the maintainer declined it.`
        : `A current GitHub admin of ${fullName} can opt it out so nobody can launch a market for it on repo.ing.`}</p>}
    {!canAct ? <p className="decision-hint">Maintainer? Verify with GitHub above, then you can {decision ? `withdraw this ${word}` : 'decline this market'} here.</p>
      : <button ref={trigger} type="button" className={`decision-trigger${decision ? '' : ' is-decline'}`} aria-expanded={open} aria-controls={panelId}
        onClick={() => { if (!busy) toggle(!open) }}>{decision ? `Withdraw ${word}` : live ? 'Decline this market' : 'Opt out of repo.ing'}</button>}
    {canAct && open && <div id={panelId} className="decision-confirm">
      {decision ? <>
        <p className="decision-confirm-title">Withdraw your {word}?</p>
        <p className="decision-confirm-copy">{live ? 'The banner comes off the token page and repo.ing may feature this market again.' : `Anyone can launch a market for ${fullName} on repo.ing again.`}</p>
        <div className="decision-actions">
          <button type="button" className="button outline" disabled={busy} onClick={() => submit('withdraw')}>{busy ? 'Checking GitHub access…' : `Withdraw ${word}`}</button>
          <button type="button" className="button outline" disabled={busy} onClick={() => toggle(false)}>Keep it</button>
        </div>
      </> : <>
        <p className="decision-confirm-title">{live ? `Decline the ${fullName} market?` : `Opt ${fullName} out of repo.ing?`}</p>
        <Effects live={live} fullName={fullName}/>
        <label className="decision-note-label" htmlFor={`${id}-note`}>Public note <span>optional</span></label>
        <textarea id={`${id}-note`} value={note} disabled={busy} rows={3} aria-describedby={`${id}-note-help`}
          placeholder={live ? 'Why you declined, in your own words' : 'Shown if someone tries to launch it'} onChange={event => setNote(event.target.value)}/>
        <div id={`${id}-note-help`} className="decision-note-help"><span>Plain text, shown publicly. Links only to github.com.</span>
          <span className={noteLength > NOTE_LIMIT ? 'is-over' : undefined}>{noteLength}/{NOTE_LIMIT}</span></div>
        <div className="decision-actions">
          <button type="button" className="button decline" disabled={busy || noteLength > NOTE_LIMIT} onClick={() => submit(live ? 'decline' : 'opt_out')}>
            {busy ? 'Checking GitHub access…' : live ? 'Decline this market' : 'Opt out'}</button>
          <button type="button" className="button outline" disabled={busy} onClick={() => toggle(false)}>Cancel</button>
        </div>
      </>}
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {done && <p className="decision-done" role="status"><Check size={15} aria-hidden="true"/>{done}</p>}
  </section>
}
