'use client'

import { useCallback, useEffect, useState } from 'react'
import { HookNativeLaunch } from './hooklab-native-launch'
import { CREATOR_FEE_BPS_CHOICES, DEFAULT_CREATOR_FEE_BPS, WALLET_CAP_BPS_CHOICES, DEFAULT_WALLET_CAP_BPS, percent } from '../../src/hooklab-launch-menus.mjs'
import { readLaunchHandoff } from '../lib/hooklab-launch-handoff.mjs'

const endpoint = '/api/hook-lab/launch-requests'
const statusText = {
  queued: 'Queued. repo.ing reviews launch requests one at a time; you will be invited here.',
  invited: 'Invited. Prepare and sign below before the invite ends. repo.ing approves your launch signature live.',
  launching: 'Launching. Keep this page open until your launch is finalized.',
  launched: 'Launched.',
  declined: 'This request was declined. You can submit a new request.',
  cancelled: 'You cancelled this request.',
  'invite-expired': 'Your invite ended before the launch started. Submit a new request when you are ready.',
}
const open = new Set(['queued', 'invited', 'launching'])

async function call(body) {
  const response = await fetch(endpoint, body
    ? { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' })
  const value = await response.json().catch(() => ({}))
  if (response.status === 401) return { signedOut: true, ...value }
  if (!response.ok) throw Error(value.error || 'Launch requests are unavailable right now.')
  return value
}

// Owner-approved release: creators queue a coin; nothing is prepared or signed until repo.ing
// invites that exact coin, and then the existing launch flow continues with those locked details.
export function HookOwnerApprovedLaunch({ genesisHash, initialBlockers = [] }) {
  const [online, setOnline] = useState(null)
  const [request, setRequest] = useState(null)
  const [signedOut, setSignedOut] = useState(false)
  const [form, setForm] = useState({ name: '', symbol: '', uri: '', creatorFeeBps: DEFAULT_CREATOR_FEE_BPS, capBps: DEFAULT_WALLET_CAP_BPS })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Details carried over from a Max wallet draft (/hooks/new); invalid values are ignored.
  useEffect(() => { const handoff = readLaunchHandoff(window.location.search); if (Object.keys(handoff).length) setForm(current => ({ ...current, ...handoff })) }, [])

  const refresh = useCallback(async () => {
    try {
      const available = await call(); setOnline(!!available.online)
      const mine = await call({ action: 'get' })
      if (mine.signedOut) { setSignedOut(true); return }
      setSignedOut(false); setRequest(mine.request ?? null); setOnline(!!mine.online)
    } catch (e) { setError(e.message) }
  }, [])
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5_000); return () => clearInterval(timer) }, [refresh])

  const act = body => async () => {
    setBusy(true); setError('')
    try { const value = await call(body); if (value.signedOut) setSignedOut(true); else { setRequest(value.request ?? null); setOnline(!!value.online) } }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const approvedIntent = request && ['invited', 'launching'].includes(request.status)
    ? { name: request.name, symbol: request.symbol, uri: request.uri, creatorFeeBps: request.creatorFeeBps, capBps: request.capBps } : null

  return <>
    <section className="inner-card" aria-live="polite">
      <h2>Request a launch</h2>
      <p role="status"><strong>{online === null ? 'Checking repo.ing approvals…' : online ? 'repo.ing approvals are online' : 'repo.ing approvals are offline'}</strong>
        {online === false && ' — you can still queue a request; you will be invited when approvals are open.'}</p>
      {signedOut && <p><strong>Step 1:</strong> sign in with your wallet below (“Review sign-in message”). This panel updates by itself a few seconds later.{form.name && <> Your coin <strong>{form.name} · {form.symbol}</strong> ({percent(form.creatorFeeBps)} fee, {percent(form.capBps)} wallet cap) is ready to queue.</>}</p>}
      {request && <dl><dt>Your request</dt><dd>{request.symbol} · {request.name}</dd><dt>Creator fee / wallet cap</dt><dd>{percent(request.creatorFeeBps)} of each trade / {percent(request.capBps)} of supply per wallet</dd><dt>Status</dt><dd>{statusText[request.status] ?? request.status}</dd>
        {request.inviteExpiresAt && request.status === 'invited' && <><dt>Invite ends</dt><dd>{new Date(request.inviteExpiresAt).toLocaleTimeString()}</dd></>}</dl>}
      {request && ['queued', 'invited'].includes(request.status) && <button disabled={busy} onClick={act({ action: 'cancel', requestId: request.id })}>Cancel request</button>}
      {!signedOut && (!request || !open.has(request.status)) && <>
        <p>Queuing a request creates no token and asks for no signature. Coin details are locked once repo.ing invites you.</p>
        {Object.entries({ name: 'Coin name', symbol: 'Symbol', uri: 'Metadata HTTPS URL (optional)' }).map(([key, label]) =>
          <label key={key} style={{ display: 'block', marginBottom: 12 }}>{label}<input style={{ display: 'block', width: '100%' }} value={form[key]} disabled={busy} onChange={event => setForm({ ...form, [key]: event.target.value })}/></label>)}
        <label style={{ display: 'block', marginBottom: 12 }}>Creator fee per trade (you keep 75%, repo.ing 25%)<select style={{ display: 'block' }} value={form.creatorFeeBps} disabled={busy} onChange={event => setForm({ ...form, creatorFeeBps: Number(event.target.value) })}>
          {CREATOR_FEE_BPS_CHOICES.map(bps => <option key={bps} value={bps}>{percent(bps)}{bps === DEFAULT_CREATOR_FEE_BPS ? ' (default)' : ''}</option>)}</select></label>
        <label style={{ display: 'block', marginBottom: 12 }}>Maximum per wallet until graduation<select style={{ display: 'block' }} value={form.capBps} disabled={busy} onChange={event => setForm({ ...form, capBps: Number(event.target.value) })}>
          {WALLET_CAP_BPS_CHOICES.map(bps => <option key={bps} value={bps}>{percent(bps)} of supply{bps === DEFAULT_WALLET_CAP_BPS ? ' (default)' : ''}</option>)}</select></label>
        <button className="button primary" disabled={busy || !form.name || !form.symbol} onClick={act({ action: 'create', requestId: crypto.randomUUID(), ...form })}>{busy ? 'Working…' : 'Queue launch request'}</button>
      </>}
      {error && <p role="alert">{error}</p>}
    </section>
    {/* Distinct keys remount the launcher when the invite lands, so it drops the waiting state it started with. */}
    {approvedIntent
      ? <HookNativeLaunch key="invited" genesisHash={genesisHash} initialBlockers={initialBlockers} approvedIntent={approvedIntent}/>
      : <HookNativeLaunch key="waiting" genesisHash={genesisHash} initialBlockers={[...initialBlockers, { code: 'AWAITING_OWNER_INVITE', message: 'Queue a launch request above. Preparation starts after repo.ing invites your coin.' }]}/>}
  </>
}
