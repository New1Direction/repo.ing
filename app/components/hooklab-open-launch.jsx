'use client'

// Self-serve launch: connect → your coin → review → sign → live. No request, invite or approval: the creator picks the
// fee and max per wallet from what the chain offers, checks what they pay, and approves twice in one guided step (the
// coin's setup, then opening trading). Everything signed is the server's exact review; the server re-checks it all.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, ChevronDown, Info, LoaderCircle } from 'lucide-react'
import { useWallet } from './wallet'
import { HookWalletSignIn, shortAddress, useHookWalletSession } from './hooklab-wallet-signin'
import { HookCoinFields, HookCoinPreview, HookLaunchNotes } from './hooklab-coin-form'
import { coinProblem } from './hooklab-launch-request'
import { percent } from '../../src/hooklab-launch-menus.mjs'
import { coinImageUrl, telegramHandle, websiteUrl, xHandle } from '../../src/hooklab-coin-profile.mjs'
import { reservationInput } from '../lib/hooklab-native-launch-form.mjs'
import { signReviewedLaunch } from '../lib/hooklab-launch-wallet.mjs'
import { OPEN_LAUNCH_NOTE, OPEN_LAUNCH_STEPS, TWO_APPROVALS, defaultOpenChoices, menuChoice, nextOpenLaunchAction, openCreationProblem, openLaunchCosts,
  openLaunchPrice, openLaunchStatus, openMenus, solOrWallet } from '../lib/hooklab-open-launch.mjs'

const REQUESTS = '/api/hook-lab/launch-requests', LAUNCH = '/api/hook-lab/native-launch'
// The same key the guided launcher uses, so a launch started anywhere on this device resumes here.
const STORAGE_KEY = 'repo.ing.hooks.native-launch.ids.v1'
const NO_IDS = Object.freeze({ operationId: '', preparationId: '', launchId: '' })
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const EMPTY_COIN = { name: '', symbol: '', image: null, description: '', x: '', website: '', telegram: '' }
const valid = (read, value) => { try { return read(value) } catch { return null } }
const previewProfile = coin => ({ description: '', x: valid(xHandle, coin.x), website: valid(websiteUrl, coin.website), telegram: valid(telegramHandle, coin.telegram) })

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({}))
  if (response.status === 401) throw Error('Your sign-in expired. Sign in again to continue.')
  if (value.status === 'blocked') throw Error('Launching isn’t available right now. Nothing was signed.')
  if (!response.ok || value.status !== 'available') throw Error(value.error || 'Launching isn’t available right now. Try again in a minute.')
  return value
}
async function available() {
  const response = await fetch(REQUESTS, { cache: 'no-store' }), value = await response.json().catch(() => ({}))
  if (!response.ok) throw Error(value.error || 'Launching isn’t available right now. Try again in a minute.')
  return value
}
const readIds = () => { try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); return saved && Object.keys(NO_IDS).every(k => saved[k] === '' || uuid(saved[k])) ? saved : NO_IDS } catch { return NO_IDS } }

export function OpenLaunchSteps({ phase }) {
  return <ol className="hooks-launch-steps" aria-label="Launch progress">{OPEN_LAUNCH_STEPS.map((label, index) =>
    <li key={label} data-state={index < phase ? 'done' : index === phase ? 'current' : 'todo'} aria-current={index === phase ? 'step' : undefined}>
      <span>{index < phase ? <Check size={14} aria-hidden="true"/> : index + 1}</span>{label}</li>)}</ol>
}

// The review screen: only what the creator pays, the price, their rules, the graduation target and the note.
export function OpenLaunchReview({ coin, image, profile, openCreation, costs, price, busy = false, onSign, onEdit, editLabel = 'Edit' }) {
  const { rows, totalLamports } = openLaunchCosts(openCreation, costs), values = openLaunchPrice(price), problem = openCreationProblem(openCreation)
  return <section className="launch-panel hooks-open-review" aria-labelledby="hooks-review-title">
    <h2 id="hooks-review-title">Check your launch</h2>
    <HookCoinPreview image={image} name={coin.name} symbol={coin.symbol} capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} profile={profile}/>
    <div className="hooks-open-review-grid">
      <div className="inner-card fee-breakdown"><h3>What you pay</h3>
        {rows.map(row => <div key={row.key} className="fee-line"><span>{row.label}<small>{row.about}</small></span><strong>{solOrWallet(row.lamports)}</strong></div>)}
        <div className="hooks-cost"><span>Total, about</span><strong>{solOrWallet(totalLamports)}</strong><small>Your wallet shows the exact amount before you approve.</small></div>
      </div>
      <div className="inner-card fee-breakdown"><h3>Your coin</h3>
        <div className="fee-line"><span>Opening price<small>Its market value when trading opens</small></span><strong>{values?.opening ?? 'Set when you sign'}</strong></div>
        <div className="fee-line"><span>Graduates at<small>{values ? `Its market value once buyers put in ${values.raise}` : 'Its market value when the curve sells out'}</small></span><strong>{values?.graduation ?? 'Set when you sign'}</strong></div>
        <div className="fee-line"><span>Creator fee<small>On every buy and sell, in SOL</small></span><strong>{percent(coin.creatorFeeBps)}</strong></div>
        <div className="fee-line"><span>Max per wallet<small>Until the coin graduates</small></span><strong>{percent(coin.capBps)}</strong></div>
      </div>
    </div>
    <p className="hooks-open-note" role="note"><Info size={18} aria-hidden="true"/><span>{OPEN_LAUNCH_NOTE}</span></p>
    {problem && <p className="hooks-ended" role="status">{problem}</p>}
    <div className="launch-review-actions">
      <button type="button" className="button primary" disabled={busy || !!problem} onClick={onSign}>{busy ? 'Starting…' : 'Sign and launch'}</button>
      {onEdit && <button type="button" className="button outline" disabled={busy} onClick={onEdit}>{editLabel}</button>}
    </div>
    <p className="form-fineprint">{TWO_APPROVALS}</p>
  </section>
}

// The one guided signing step: two wallet approvals, each confirmed on Solana before the next.
export function OpenLaunchSigning({ symbol, stage, status, busy, error, canRetry, onRetry }) {
  const second = stage === 'launch'
  const items = [['Approve the setup', 'Creates your coin and its accounts.'], ['Approve the launch', 'Opens trading with your rules.']]
  return <section className="launch-panel hooks-open-signing" aria-labelledby="hooks-signing-title" aria-live="polite">
    <h2 id="hooks-signing-title">Launching ${symbol}</h2>
    <p className="launch-subtitle">{TWO_APPROVALS} Keep this page open until it says your coin is live.</p>
    <ol className="hooks-sign-steps hooks-open-progress" aria-label="Wallet approvals">{items.map(([label, about], index) => {
      const state = index < (second ? 1 : 0) ? 'done' : index === (second ? 1 : 0) ? 'current' : 'todo'
      return <li key={label} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
        <span>{state === 'done' ? <Check size={14} aria-hidden="true"/> : state === 'current' && busy ? <LoaderCircle size={14} className="image-picker-spinner" aria-hidden="true"/> : index + 1}</span>
        <div><strong>{label}</strong><small>{about}</small></div></li>
    })}</ol>
    {status && <p className="hooks-operation-status" role="status">{status}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {canRetry && <button type="button" className="button primary" disabled={busy} onClick={onRetry}>{busy ? 'Working…' : 'Continue'}</button>}
  </section>
}

export function OpenLaunchLive({ symbol, mint, onAnother }) {
  return <section className="launch-panel hooks-status" aria-live="polite">
    <h2>${symbol} is live</h2>
    <p>Anyone can buy and sell it on repo.ing now, in SOL. Share its page so people can find it.</p>
    {mint && <p className="hooks-fine">Coin address <code title={mint}>{shortAddress(mint)}</code></p>}
    <div className="launch-review-actions">
      {mint && <Link className="button primary" href={`/hooks/token/${mint}`}>Open your coin <ArrowRight size={16} aria-hidden="true"/></Link>}
      {onAnother && <button type="button" className="button outline" onClick={onAnother}>Launch another coin</button>}
    </div>
  </section>
}

// initial: the first render's state (tests; the page starts empty and loads it). { availability, request, step, operation }.
export function HookOpenLaunch({ genesisHash, initialBlockers = [], initial = {} }) {
  const { wallet, provider } = useWallet()
  const session = useHookWalletSession(genesisHash)
  const walletRef = useRef(wallet); walletRef.current = wallet
  const running = useRef(false), idsRef = useRef(NO_IDS)
  const [availability, setAvailability] = useState(initial.availability ?? null)
  const [request, setRequest] = useState(initial.request ?? null)
  const [coin, setCoin] = useState({ ...EMPTY_COIN, ...defaultOpenChoices(initial.availability?.openCreation), ...initial.coin })
  const [step, setStep] = useState(initial.step ?? 'coin')
  const [operation, setOperation] = useState(initial.operation ?? null)
  const [mint, setMint] = useState(initial.mint ?? null), [pricing, setPricing] = useState(null)
  const [imageBusy, setImageBusy] = useState(false), [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(''), [error, setError] = useState(''), [canRetry, setCanRetry] = useState(false)
  const openCreation = availability?.openCreation ?? null, menus = openMenus(openCreation)
  const set = useCallback(patch => { setCoin(current => ({ ...current, ...patch })); setError('') }, [])
  const retain = next => { idsRef.current = next; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {} }

  const refresh = useCallback(async () => {
    try {
      const value = await available(); setAvailability(value)
      setCoin(current => ({ ...current, creatorFeeBps: menuChoice(value.openCreation?.creatorFeeBps, current.creatorFeeBps, current.creatorFeeBps),
        capBps: menuChoice(value.openCreation?.capBps, current.capBps, current.capBps) }))
      if (!session.signedIn) return
      const mine = await post(REQUESTS, { action: 'get' }); setRequest(mine.request ?? null)
    } catch (e) { if (!running.current) setError(e.message) }
  }, [session.signedIn])
  useEffect(() => { idsRef.current = readIds(); refresh(); const timer = setInterval(() => { if (!running.current) refresh() }, 30_000); return () => clearInterval(timer) }, [refresh])
  // A recorded coin that has not launched yet goes straight to its review; one mid-launch resumes its signing step.
  useEffect(() => {
    if (!request || running.current || step === 'live') return
    if (request.status === 'queued') { setCoin(current => ({ ...current, name: request.name, symbol: request.symbol, creatorFeeBps: request.creatorFeeBps, capBps: request.capBps })); setStep('review') }
    if (request.status === 'launching') { setStep('sign'); setCanRetry(true); setStatus('Your launch is waiting for you. Continue to finish it.') }
  }, [request?.id, request?.status])

  const api = body => post(LAUNCH, body)
  // Every operation the server returns must be this wallet's, on this network, for this launch.
  const checked = (op, signingId) => {
    if (!op || op.id !== signingId || !['preparation', 'launch'].includes(op.stage) || op.review?.genesisHash !== genesisHash
      || op.review?.wallet !== walletRef.current || op.custodyOperationId !== idsRef.current.operationId) throw Error('This launch belongs to another wallet. Nothing was signed.')
    setOperation(op); return op
  }
  const review = async (stage, fresh = false) => {
    const key = stage === 'preparation' ? 'preparationId' : 'launchId', ids = idsRef.current
    const next = { ...ids, [key]: !fresh && ids[key] ? ids[key] : crypto.randomUUID() }; retain(next)
    return checked((await api({ action: 'review', operationId: next.operationId, signingId: next[key], stage })).operation, next[key])
  }
  // A recorded coin not bound to a launch yet gets a fresh operation; one already bound keeps it (and the signing IDs this
  // device kept for it). IDs from any other launch are never reused.
  const reserve = async current => {
    const operationId = current.custodyOperationId ?? crypto.randomUUID()
    const ids = idsRef.current.operationId === operationId ? idsRef.current : { ...NO_IDS, operationId }
    retain(ids)
    const input = reservationInput({}, { name: current.name, symbol: current.symbol, uri: current.uri, creatorFeeBps: current.creatorFeeBps, capBps: current.capBps })
    const value = await api({ action: 'reserve', operationId: ids.operationId, ...input })
    if (value.operationId !== ids.operationId || !value.mint) throw Error('The launch changed while it was starting. Nothing was signed.')
    setMint(value.mint); if (value.pricing) setPricing(value.pricing)
  }
  const signStep = async op => {
    const walletRequest = await api({ action: 'wallet-request', signingId: op.id })
    const signedTransactionBase64 = await signReviewedLaunch({ walletRequest, reviewed: op.review, address: walletRef.current, genesisHash, currentWallet: () => walletRef.current, adapter: provider() })
    return checked((await api({ action: 'retain-wallet', signingId: op.id, signedTransactionBase64 })).operation, op.id)
  }
  // Drives the launch to live: each move is what the last server answer calls for (nextOpenLaunchAction).
  async function drive(current) {
    let op = operation
    if (!op && current.status === 'launching' && uuid(idsRef.current.launchId || idsRef.current.preparationId))
      op = checked((await api({ action: 'get', signingId: idsRef.current.launchId || idsRef.current.preparationId })).operation, idsRef.current.launchId || idsRef.current.preparationId)
    for (let moves = 0; moves < 400; moves++) {
      const action = nextOpenLaunchAction(op, { wallet: walletRef.current })
      setStatus(openLaunchStatus(op, action))
      if (action === 'reserve') { await reserve(current); op = await review('preparation'); continue }
      if (action === 'sign') { op = await signStep(op); continue }
      if (['cosign', 'submit', 'refresh'].includes(action)) { op = checked((await api({ action: action === 'refresh' ? 'refresh-review' : action, signingId: op.id })).operation, op.id); continue }
      if (action === 'close') { op = checked((await api({ action: 'expire', signingId: op.id })).operation, op.id); continue }
      if (action === 'reconcile' || action === 'wait') { await sleep(4000); op = checked((await api({ action: action === 'wait' ? 'get' : 'reconcile', signingId: op.id })).operation, op.id); continue }
      if (action === 'fresh') { op = await review(op.stage, true); continue }
      if (action === 'launch') { op = await review('launch'); continue }
      if (action === 'live') { setStep('live'); setStatus(''); return }
      throw Error('This launch needs a check before anything else is signed. Keep this page and your recovery IDs; nothing more will be signed.')
    }
  }
  const signAndLaunch = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setError(''); setCanRetry(false)
    try {
      if (!session.signedIn && !await session.signIn()) return
      let current = request && ['queued', 'launching'].includes(request.status) ? request : null
      if (!current) {
        const problem = coinProblem(coin) || openCreationProblem(openCreation); if (problem) throw Error(problem)
        const created = await post(REQUESTS, { action: 'create', requestId: crypto.randomUUID(), name: coin.name.trim(), symbol: coin.symbol, image: coin.image,
          description: coin.description, x: coin.x, website: coin.website, telegram: coin.telegram, creatorFeeBps: coin.creatorFeeBps, capBps: coin.capBps })
        current = created.request; setRequest(current)
      }
      setStep('sign')
      await drive(current)
    } catch (e) {
      const rejected = /reject|declin|cancel/i.test(e?.message ?? '')
      setError(rejected ? 'You closed the request in your wallet. Nothing was sent.' : e.message || 'The launch stopped. Nothing more was signed.'); setCanRetry(true)
    } finally { running.current = false; setBusy(false) }
  }
  const startOver = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { if (request?.status === 'queued') { const value = await post(REQUESTS, { action: 'cancel', requestId: request.id }); setRequest(value.request ?? null) }
      retain(NO_IDS); setOperation(null); setMint(null); setPricing(null); setCoin(current => ({ ...EMPTY_COIN, creatorFeeBps: current.creatorFeeBps, capBps: current.capBps })); setStep('coin') }
    catch (e) { setError(e.message) } finally { running.current = false; setBusy(false) }
  }
  const toReview = event => {
    event.preventDefault()
    const problem = coinProblem(coin) || openCreationProblem(openCreation)
    if (problem) { setError(problem); return }
    setError(''); setStep('review')
  }

  const recorded = request && ['queued', 'launching', 'launched'].includes(request.status) ? request : null
  const shown = recorded && step !== 'coin' ? { name: recorded.name, symbol: recorded.symbol, creatorFeeBps: recorded.creatorFeeBps, capBps: recorded.capBps } : { ...coin, name: coin.name.trim() }
  const image = recorded?.profile && step !== 'coin' ? coinImageUrl('', recorded.id, 128) : coin.image
  const phase = { coin: 0, review: 1, sign: 2, live: OPEN_LAUNCH_STEPS.length }[step]
  const paused = initialBlockers.length > 0 || !!openCreationProblem(openCreation)
  return <div className="hooks-launch hooks-open-launch">
    <OpenLaunchSteps phase={phase}/>
    {step === 'coin' && <form className="launch-panel hooks-launch-panel" onSubmit={toReview} noValidate>
      {availability && paused && <p className="hooks-ended" role="status">{openCreationProblem(openCreation) || 'Launching isn’t available right now. Try again later.'}</p>}
      {!session.signedIn && session.checked && <p className="hooks-returning">Already started a launch? <button type="button" className="hooks-text-button" disabled={session.busy} onClick={session.signIn}>{session.busy ? 'Check your wallet…' : 'Sign in to continue it'}</button></p>}
      <div className="launch-columns">
        <fieldset className="launch-fields launch-fieldset" disabled={busy}>
          <h2>Your coin</h2><p className="launch-subtitle">How people will see it on repo.ing.</p>
          <HookCoinPreview image={coin.image} name={coin.name.trim()} symbol={coin.symbol} capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} profile={previewProfile(coin)}/>
          <HookCoinFields form={coin} set={set} disabled={busy} onImageBusy={setImageBusy} menus={menus}/>
        </fieldset>
        <div className="launch-side"><HookLaunchNotes capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} launchPrice={availability?.launchPrice} open/></div>
      </div>
      {(error || session.error) && <p className="inline-error hooks-submit-error" role="alert">{error || session.error}</p>}
      <button type="submit" className="button primary launch-submit" disabled={busy || imageBusy}>{imageBusy ? 'Preparing image…' : 'Review your launch'}</button>
      <p className="form-fineprint">Nothing is created or signed until you approve it in your wallet.</p>
    </form>}
    {step === 'review' && <>
      {!session.signedIn && session.checked && <HookWalletSignIn genesisHash={genesisHash} session={session} title="Sign in to launch">Sign in with the wallet that will own this coin. It’s free and sends no transaction.</HookWalletSignIn>}
      <OpenLaunchReview coin={shown} image={image} profile={recorded?.profile ?? previewProfile(coin)} openCreation={openCreation} costs={availability?.costs} price={pricing ?? recorded?.pricing ?? availability?.launchPrice}
        busy={busy || session.busy} onSign={signAndLaunch} onEdit={recorded?.status === 'queued' ? startOver : () => setStep('coin')} editLabel={recorded?.status === 'queued' ? 'Start over' : 'Edit'}/>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </>}
    {step === 'sign' && <OpenLaunchSigning symbol={shown.symbol} stage={operation?.stage} status={status} busy={busy} error={error} canRetry={canRetry} onRetry={signAndLaunch}/>}
    {step === 'live' && <OpenLaunchLive symbol={shown.symbol} mint={mint ?? recorded?.mint} onAnother={startOver}/>}
    {step === 'sign' && <details className="launch-customize hooks-recovery"><summary><span>Recovery IDs</span><ChevronDown size={18} aria-hidden="true"/></summary>
      <div className="launch-customize-body"><p>If the page reloads, these pick up the same launch on this device. Never start a second launch to get around an unclear result.</p>
        <dl className="hooks-recovery-ids">{Object.entries({ operationId: 'Launch', preparationId: 'Setup approval', launchId: 'Launch approval' }).map(([key, label]) =>
          <div key={key}><dt>{label}</dt><dd><code>{idsRef.current[key] || '—'}</code></dd></div>)}</dl></div></details>}
  </div>
}
