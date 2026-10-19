'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Check } from 'lucide-react'
import { HookNativeLaunch } from './hooklab-native-launch'
import { HookWalletSignIn, shortAddress, useHookWalletSession } from './hooklab-wallet-signin'
import { HookCoinFields, HookCoinPreview, HookLaunchNotes } from './hooklab-coin-form'
import { DEFAULT_CREATOR_FEE_BPS, DEFAULT_WALLET_CAP_BPS } from '../../src/hooklab-launch-menus.mjs'
import { coinImageUrl, coinProfileFields, telegramHandle, websiteUrl, xHandle } from '../../src/hooklab-coin-profile.mjs'
import { readLaunchHandoff } from '../lib/hooklab-launch-handoff.mjs'

const endpoint = '/api/hook-lab/launch-requests'
const open = new Set(['queued', 'invited', 'launching'])
const endedText = {
  declined: 'repo.ing didn’t approve your last request. You can change the details and send a new one.',
  cancelled: 'You cancelled your last request. Send a new one whenever you’re ready.',
  'invite-expired': 'Your invite ended before the launch started. Send a new request when you’re ready.',
}
const EMPTY_COIN = { name: '', symbol: '', image: null, description: '', x: '', website: '', telegram: '', creatorFeeBps: DEFAULT_CREATOR_FEE_BPS, capBps: DEFAULT_WALLET_CAP_BPS }
const bytes = value => new TextEncoder().encode(value).length
// Links shown in the preview: each one as soon as it is valid, while the others are still being typed.
const valid = (read, value) => { try { return read(value) } catch { return null } }
const previewProfile = coin => ({ description: '', x: valid(xHandle, coin.x), website: valid(websiteUrl, coin.website), telegram: valid(telegramHandle, coin.telegram) })

async function call(body) {
  const response = await fetch(endpoint, body
    ? { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' })
  const value = await response.json().catch(() => ({}))
  if (response.status === 401) return { signedOut: true, ...value }
  if (!response.ok) throw Error(value.error || 'Launch requests are unavailable right now. Try again in a minute.')
  return value
}

// The first thing missing, in plain words, or '' when the coin is ready to request.
export function coinProblem(coin) {
  const name = coin.name.trim()
  if (!name) return 'Give your coin a name.'
  if (bytes(name) > 32) return 'Use a shorter name (up to 32 characters).'
  if (!coin.symbol) return 'Choose a ticker.'
  if (!coin.image) return 'Add a coin image.'
  try { coinProfileFields(coin) } catch (error) { return error.message }
  return ''
}

const STEPS = ['Your coin', 'repo.ing approval', 'Sign & launch', 'Live']
// phase: index of the current step; STEPS.length when the coin is live.
export function HookLaunchSteps({ phase }) {
  return <ol className="hooks-launch-steps" aria-label="Launch progress">{STEPS.map((label, index) =>
    <li key={label} data-state={index < phase ? 'done' : index === phase ? 'current' : 'todo'} aria-current={index === phase ? 'step' : undefined}>
      <span>{index < phase ? <Check size={14} aria-hidden="true"/> : index + 1}</span>{label}</li>)}</ol>
}

export function RequestStatus({ request, online, busy, error = '', onCancel, onAnother }) {
  const symbol = `$${request.symbol}`
  const until = request.inviteExpiresAt && new Date(request.inviteExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return <section className="launch-panel hooks-status" aria-live="polite">
    <HookCoinPreview image={request.profile ? coinImageUrl('', request.id, 128) : null} name={request.name} symbol={request.symbol}
      capBps={request.capBps} creatorFeeBps={request.creatorFeeBps} profile={request.profile}/>
    {request.status === 'queued' && <>
      <h2>Waiting for approval</h2>
      <p>repo.ing checks each coin and will invite you right here. You can close this page; your request keeps its place.</p>
      <p className={`hooks-online${online ? ' is-online' : ''}`}><span aria-hidden="true"/>{online ? 'repo.ing approvals are online now.' : 'repo.ing approvals are offline right now. Your request stays in line.'}</p>
    </>}
    {request.status === 'invited' && <>
      <h2>You’re invited. Launch {symbol} now.</h2>
      <p>Your invite is open until {until}. Follow the steps below and approve each one in your wallet.</p>
    </>}
    {request.status === 'launching' && <><h2>Launching {symbol}</h2><p>Keep this page open until both signatures are confirmed.</p></>}
    {request.status === 'launched' && <>
      <h2>{symbol} is live</h2>
      <p>Anyone can buy and sell it on repo.ing now. Share it so people can find it.</p>
    </>}
    <div className="launch-review-actions">
      {request.status === 'launched' && <><Link className="button primary" href="/hooks/trade">Buy or sell <ArrowRight size={16} aria-hidden="true"/></Link>
        <button type="button" className="button outline" onClick={onAnother}>Launch another coin</button></>}
      {['queued', 'invited'].includes(request.status) && <button type="button" className="button outline" disabled={busy} onClick={onCancel}>{busy ? 'Cancelling…' : 'Cancel request'}</button>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}

// Owner-approved release: creators describe their coin and queue it; nothing is prepared or signed until repo.ing
// invites that exact coin, and then the guided launcher continues with those locked details.
export function HookOwnerApprovedLaunch({ genesisHash, initialBlockers = [] }) {
  const session = useHookWalletSession(genesisHash)
  const [online, setOnline] = useState(null)
  const [request, setRequest] = useState(null)
  const [coin, setCoin] = useState(EMPTY_COIN)
  const [imageBusy, setImageBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [another, setAnother] = useState(false)
  // The launcher stays up after the launch lands only if it ran on this page (it holds the receipt).
  const [signedHere, setSignedHere] = useState(false)
  // Details carried over from a Max wallet draft (/hooks/new); invalid values are ignored.
  useEffect(() => { const handoff = readLaunchHandoff(window.location.search); if (Object.keys(handoff).length) setCoin(current => ({ ...current, ...handoff })) }, [])
  const set = useCallback(patch => { setCoin(current => ({ ...current, ...patch })); setError('') }, [])

  const signedIn = session.signedIn
  const refresh = useCallback(async () => {
    try {
      const available = await call(); setOnline(!!available.online)
      // Signed out (or the 30-minute session lapsed): keep showing the last request; signing in refreshes it.
      if (!signedIn) return
      const mine = await call({ action: 'get' })
      if (mine.signedOut) return
      setRequest(mine.request ?? null); setOnline(!!mine.online)
    } catch (e) { setError(e.message) }
  }, [signedIn])
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5_000); return () => clearInterval(timer) }, [refresh])

  const act = work => async () => {
    setBusy(true); setError('')
    try { await work() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const submit = event => { event.preventDefault(); act(async () => {
    const problem = coinProblem(coin); if (problem) throw Error(problem)
    if (!signedIn && !await session.signIn()) return
    const value = await call({ action: 'create', requestId: crypto.randomUUID(), name: coin.name.trim(), symbol: coin.symbol, image: coin.image,
      description: coin.description, x: coin.x, website: coin.website, telegram: coin.telegram, creatorFeeBps: coin.creatorFeeBps, capBps: coin.capBps })
    if (value.signedOut) throw Error('Your sign-in expired. Sign in again to send the request.')
    setRequest(value.request ?? null); setOnline(!!value.online); setAnother(false)
  })() }
  const signOut = async () => { await session.signOut(); setRequest(null) }
  const cancel = act(async () => { const value = await call({ action: 'cancel', requestId: request.id }); if (!value.signedOut) setRequest(value.request ?? null) })

  const status = request?.status
  useEffect(() => { if (status === 'invited' || status === 'launching') setSignedHere(true) }, [status])
  const showStatus = request && !another && (open.has(status) || status === 'launched')
  const phase = !showStatus ? 0 : status === 'queued' ? 1 : status === 'launched' ? STEPS.length : 2
  const approvedIntent = showStatus && (status === 'invited' || status === 'launching' || (status === 'launched' && signedHere))
    ? { name: request.name, symbol: request.symbol, uri: request.uri, creatorFeeBps: request.creatorFeeBps, capBps: request.capBps } : null
  const paused = initialBlockers.length > 0
  const ready = !coinProblem(coin)
  const cta = imageBusy ? 'Preparing image…' : session.busy ? 'Check your wallet…' : busy ? 'Sending…' : signedIn ? 'Request launch' : 'Sign in and request launch'

  return <div className="hooks-launch">
    <HookLaunchSteps phase={phase}/>
    {showStatus && !signedIn && session.checked && status === 'queued' && <HookWalletSignIn genesisHash={genesisHash} session={session} title="Sign in to see updates">
      Your request is saved. Sign in with the same wallet to see when repo.ing invites you.</HookWalletSignIn>}
    {showStatus ? <RequestStatus request={request} online={online} busy={busy} error={error} onCancel={cancel} onAnother={() => setAnother(true)}/>
      : <form className="launch-panel hooks-launch-panel" onSubmit={submit} noValidate>
        {status && endedText[status] && !another && <p className="hooks-ended" role="status">{endedText[status]}</p>}
        {paused && <p className="hooks-ended" role="status">Launching is paused right now. You can still send a request; it waits in line.</p>}
        {!signedIn && session.checked && <p className="hooks-returning">Already sent a request? <button type="button" className="hooks-text-button" disabled={session.busy} onClick={session.signIn}>{session.busy ? 'Check your wallet…' : 'Sign in to see it'}</button></p>}
        <div className="launch-columns">
          <fieldset className="launch-fields launch-fieldset" disabled={busy}>
            <h2>Your coin</h2><p className="launch-subtitle">How people will see it on repo.ing.</p>
            <HookCoinPreview image={coin.image} name={coin.name.trim()} symbol={coin.symbol} capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} profile={previewProfile(coin)}/>
            <HookCoinFields form={coin} set={set} disabled={busy} onImageBusy={setImageBusy}/>
          </fieldset>
          <div className="launch-side"><HookLaunchNotes capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps}/></div>
        </div>
        {(error || session.error) && <p className="inline-error hooks-submit-error" role="alert">{error || session.error}</p>}
        <button type="submit" className="button primary launch-submit" disabled={busy || session.busy || imageBusy || !session.checked} aria-describedby="hooks-request-note">{cta}</button>
        <p id="hooks-request-note" className="form-fineprint">{ready ? 'Free to request. Nothing is created or signed until repo.ing approves your coin.' : 'Add a name, ticker and image to send your request.'}
          {signedIn ? <> Requesting as <code title={session.identity.wallet}>{shortAddress(session.identity.wallet)}</code> · <button type="button" className="hooks-text-button" onClick={signOut}>Sign out</button></>
            : ' You’ll sign a free message to prove the wallet is yours.'}</p>
        {online !== null && <p className={`hooks-online hooks-online-center${online ? ' is-online' : ''}`}><span aria-hidden="true"/>{online ? 'repo.ing approvals are online now.' : 'repo.ing approvals are offline right now. Requests wait in line.'}</p>}
      </form>}
    {/* Distinct keys remount the launcher when the invite lands, so it starts from that invite's state. */}
    {approvedIntent && <section className="launch-panel hooks-sign-panel" aria-labelledby="hooks-sign-title">
      <h2 id="hooks-sign-title">{status === 'launched' ? 'Launch receipt' : 'Sign and launch'}</h2>
      <HookNativeLaunch key={`invited-${request.id}`} genesisHash={genesisHash} initialBlockers={initialBlockers} approvedIntent={approvedIntent}
        session={session} freshInvite={status === 'invited'} boundOperationId={request.custodyOperationId ?? null}/>
    </section>}
  </div>
}
