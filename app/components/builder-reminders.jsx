'use client'
import { useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'

async function update(body) {
  const response = await fetch('/api/builders/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const data = await response.json()
  if (!response.ok) throw Error(data.error || 'Could not update reminders.')
  return data
}
export function BuilderReminders() {
  const [data, setData] = useState(null), [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/builders/reminders', { cache: 'no-store', signal: controller.signal }).then(r => r.ok ? r.json() : null)
      .then(value => { if (!controller.signal.aborted) { setData(value); setEmail(value?.email ?? '') } }).catch(() => {})
    return () => controller.abort()
  }, [])
  if (!data || (!data.enabled && data.status === 'off')) return null
  async function save(action) {
    if (busy) return
    setBusy(true); setError('')
    try { const result = await update({ action, email }); setData(current => ({ ...current, ...result })) }
    catch (cause) { setError(cause.name === 'TimeoutError' ? 'Confirmation is delayed. Check your inbox or try again later.' : cause.message) }
    finally { setBusy(false) }
  }
  return <section className="builder-reminder-card inner-card" aria-label="Builder earnings reminders">
    <div><h2><Bell size={18} aria-hidden="true"/>Earnings reminders</h2><p>One email a day at most, when at least 0.05 SOL in new verified fees is available.</p></div>
    {data.status === 'active' ? <div className="reminder-controls"><span>Enabled for <strong>{data.email}</strong></span><button className="button outline" disabled={busy} onClick={() => save('remove')}>{busy ? 'Turning off…' : 'Turn off'}</button></div> : data.status === 'pending' ? <div className="reminder-controls" role="status"><span>Check <strong>{data.email}</strong> and confirm within 24 hours to turn reminders on.</span><button className="button outline" disabled={busy} onClick={() => save('remove')}>Cancel request</button></div> : <form onSubmit={event => { event.preventDefault(); save('subscribe') }} aria-busy={busy}><label htmlFor="builder-reminder-email">Email address</label><div className="reminder-controls"><input id="builder-reminder-email" type="email" maxLength={254} required autoComplete="email" value={email} disabled={busy} onChange={event => setEmail(event.target.value)}/><button className="button outline" disabled={busy}>{busy ? 'Sending confirmation…' : 'Enable reminders'}</button></div><small>Optional. We store your email for these reminders and remove it when you turn them off. No wallet signature or automatic claim.</small></form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}

export function ReminderLinkAction() {
  const [link, setLink] = useState(null), [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const readLink = useRef(false)
  useEffect(() => {
    if (readLink.current) return
    readLink.current = true
    const params = new URLSearchParams(location.hash.slice(1)), action = params.has('unsubscribe') ? 'unsubscribe' : 'confirm'
    setLink({ action, token: params.get(action) }); history.replaceState(null, '', location.pathname)
  }, [])
  async function act() {
    if (busy) return
    setBusy(true); setError('')
    try { setResult(await update(link)) } catch (cause) { setError(cause.message) } finally { setBusy(false) }
  }
  return <div className="inner-card reminder-link-card"><h1>{result ? result.status === 'off' ? 'Reminders turned off' : 'Email confirmed' : link?.action === 'unsubscribe' ? 'Turn off earnings reminders' : 'Confirm earnings reminders'}</h1>
    <p>{result ? result.status === 'off' ? 'Your reminder email and saved preferences have been removed.' : 'You’ll receive a digest when new verified earnings reach the minimum. No more than one email per day.' : 'This only changes email reminders. Claiming always requires the normal repository and payout checks.'}</p>
    {!result && (link?.token ? <button className="button primary" disabled={busy} onClick={act}>{busy ? 'Updating…' : link.action === 'unsubscribe' ? 'Turn off reminders' : 'Confirm email'}</button> : <p>Open the complete link from your email, or request a new one from Builders.</p>)}
    {error && <p role="alert" className="inline-error">{error}</p>}
  </div>
}
