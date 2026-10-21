'use client'

// Self-serve launch: connect → your coin → review → sign → live. No request, invite or approval: the creator picks the
// fee and max per wallet from what the chain offers, checks what they pay, and approves twice in one guided step (the
// coin's setup, then opening trading). Everything signed is the server's exact review; the server re-checks it all.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, ChevronDown, Info, LoaderCircle } from 'lucide-react'
import { useWallet } from './wallet'
import { HookWalletSignIn, shortAddress, useHookWalletSession } from './hooklab-wallet-signin'
import { HookCoinFields, HookCoinPreview, HookLaunchNotes, HookEconomicsReview } from './hooklab-coin-form'
import { HooksOperationError } from './hooks-ui'
import { coinProblem } from './hooklab-launch-request'
import { percent } from '../../src/hooklab-launch-menus.mjs'
import { coinImageUrl, telegramHandle, websiteUrl, xHandle } from '../../src/hooklab-coin-profile.mjs'
import { launchHookInput, reservationInput } from '../lib/hooklab-native-launch-form.mjs'
import { signReviewedLaunch } from '../lib/hooklab-launch-wallet.mjs'
import { OPEN_LAUNCH_NOTE, OPEN_LAUNCH_STEPS, TWO_APPROVALS, THREE_APPROVALS, defaultOpenChoices, menuChoice, nextOpenLaunchAction, openCreationProblem, openLaunchCosts,
  openLaunchPrice, openLaunchStatus, openMenus, solOrWallet, sameLaunchHook, SELECTED_HOOK_NOTE } from '../lib/hooklab-open-launch.mjs'

const REQUESTS = '/api/hook-lab/launch-requests', LAUNCH = '/api/hook-lab/native-launch'
// The same key the guided launcher uses, so a launch started anywhere on this device resumes here.
const STORAGE_KEY = 'repo.ing.hooks.native-launch.ids.v1'
const NO_IDS = Object.freeze({ operationId: '', setupId: '', preparationId: '', launchId: '' })
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const EMPTY_COIN = { name: '', symbol: '', image: null, description: '', x: '', website: '', telegram: '' }
const valid = (read, value) => { try { return read(value) } catch { return null } }
const previewProfile = coin => ({ description: '', x: valid(xHandle, coin.x), website: valid(websiteUrl, coin.website), telegram: valid(telegramHandle, coin.telegram) })
// Fail closed for selected setup reviews: this UI does not infer table costs from
// estimates or an availability response. Only the exact reviewed disclosure counts.
const setupDisclosureProblem = (stage, review, selectedHook) => {
  if (!selectedHook || stage !== 'hook-setup') return null
  const cost = review?.supplementalTableCost
  if (cost?.permanentFreeze === true && typeof cost.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cost.address)
    && typeof cost.rentLamports === 'string' && /^(0|[1-9]\d*)$/.test(cost.rentLamports)
    && typeof review.maxNativeDebitLamports === 'string' && /^(0|[1-9]\d*)$/.test(review.maxNativeDebitLamports)
    && BigInt(cost.rentLamports) <= BigInt(review.maxNativeDebitLamports)) return null
  return 'The address table’s exact cost and permanent-freeze warning are missing. Refresh the hook setup review before continuing. Nothing will be signed.'
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({}))
  if (response.status === 401) throw Error('Your sign-in expired. Sign in again to continue.')
  if (value.status === 'blocked') throw Error(value.error || value.blockers?.map(item => item.message).filter(Boolean).join(' ') || 'Launching isn’t available right now. Nothing was signed.')
  if (!response.ok || value.status !== 'available') throw Error(value.error || 'Launching isn’t available right now. Try again in a minute.')
  return value
}
async function available() {
  const response = await fetch(REQUESTS, { cache: 'no-store' }), value = await response.json().catch(() => ({}))
  if (!response.ok) throw Error(value.error || 'Launching isn’t available right now. Try again in a minute.')
  return value
}
const readIds = () => { try { const saved = { ...NO_IDS, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) }; return Object.keys(NO_IDS).every(k => saved[k] === '' || uuid(saved[k])) ? saved : NO_IDS } catch { return NO_IDS } }

export function OpenLaunchSteps({ phase }) {
  return <ol className="hooks-launch-steps" aria-label="Launch progress">{OPEN_LAUNCH_STEPS.map((label, index) =>
    <li key={label} data-state={index < phase ? 'done' : index === phase ? 'current' : 'todo'} aria-current={index === phase ? 'step' : undefined}>
      <span>{index < phase ? <Check size={14} aria-hidden="true"/> : index + 1}</span>{label}</li>)}</ol>
}

// The review screen: only what the creator pays, the price, their rules, the graduation target and the note.
export function OpenLaunchReview({ coin, image, profile, openCreation, costs, price, busy = false, onSign, onEdit, editLabel = 'Edit' }) {
  const selectedReady = coin.selectedHook && openCreation?.selectedHooksEnabled === true
  // Gate account rent and transaction fees are not estimates for an unreviewed custom lifecycle.
  const { rows, total, need } = openLaunchCosts(coin.selectedHook ? { launchFeeLamports: openCreation?.launchFeeLamports } : openCreation, coin.selectedHook ? {} : costs)
  const values = openLaunchPrice(price), problem = openCreationProblem(openCreation)
  const unknown = coin.selectedHook ? 'Not yet reviewed' : 'Shown in your wallet'
  const amount = value => value ? <>{value.sol}{value.usd && <small>{value.usd}</small>}</> : coin.selectedHook ? unknown : 'Set when you sign'
  return <section className="launch-panel hooks-open-review" aria-labelledby="hooks-review-title">
    <h2 id="hooks-review-title">Check your launch</h2>
    <HookCoinPreview image={image} name={coin.name} symbol={coin.symbol} capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} selectedHook={coin.selectedHook} profile={profile}/>
    {coin.selectedHook && <div role="note"><p>{selectedReady ? 'Each approval covers only the hook and settings you reviewed. Changed settings require a new review.' : SELECTED_HOOK_NOTE}</p><p>Creator revenue, hook fees and additional protocol charges are shown separately. Wallet limits depend on your chosen hook.</p>
      {coin.hookPublication && <dl>{Object.entries(coin.hookPublication.configuration).map(([name,value]) => <div key={name}><dt>{coin.hookPublication.manifest?.fields?.find(f => f.name === name)?.label ?? name}</dt><dd style={{ overflowWrap: 'anywhere' }}>{String(value)}</dd></div>)}</dl>}
      <details><summary>Technical details</summary><p>Program: <code style={{ overflowWrap: 'anywhere' }}>{coin.selectedHook.program}</code> · Flags: {coin.selectedHook.flags}</p>
        {coin.hookPublication && <p>Publication: <code style={{ overflowWrap: 'anywhere' }}>{coin.hookPublication.digest}</code></p>}</details>
    </div>}
    <HookEconomicsReview coin={coin}/>
    <div className="hooks-open-review-grid">
      <div className="inner-card fee-breakdown"><h3>What you pay</h3>
        {rows.map(row => <div key={row.key} className="fee-line"><span>{row.label} <strong>{row.amount ?? (coin.selectedHook ? unknown : 'shown in your wallet')}</strong>{row.note ? <small> {row.note}</small> : null}</span></div>)}
        <div className="hooks-cost"><span>You’ll spend about</span><strong>{total ?? unknown}</strong><small>{coin.selectedHook ? selectedReady ? 'Hook setup, coin settings and opening trading each show the most your wallet can spend before approval.' : 'Exact costs are shown at each approval. This availability check requests no transaction signature.' : 'Your wallet shows the exact amount before you approve.'}</small></div>
        {need ? <div className="hooks-cost"><span>You need at least</span><strong>{need} in your wallet</strong><small>A little more than you spend: the program checks it can cover its accounts, and the rest stays in your wallet.</small></div> : null}
      </div>
      <div className="inner-card fee-breakdown"><h3>Your coin</h3>
        <div className="fee-line"><span>Opening price<small>Its market value when trading opens</small></span><strong>{amount(values?.opening)}</strong></div>
        <div className="fee-line"><span>Graduates at<small>{values ? `Its market value once buyers put in ${values.raise}` : 'Its market value when the curve sells out'}</small></span><strong>{amount(values?.graduation)}</strong></div>
        <div className="fee-line"><span>Creator fee<small>On every buy and sell, in SOL</small></span><strong>{percent(coin.creatorFeeBps)}</strong></div>
        <div className="fee-line"><span>{coin.selectedHook ? 'Custom hook' : 'Max per wallet'}<small>{coin.selectedHook ? 'Token fees are checked on your transaction before approval' : 'Until the coin graduates'}</small></span><strong>{coin.selectedHook ? 'Wallet limits set by hook' : percent(coin.capBps)}</strong></div>
      </div>
    </div>
    <p className="hooks-open-note" role="note"><Info size={18} aria-hidden="true"/><span>{OPEN_LAUNCH_NOTE}</span></p>
    {problem && <p className="hooks-ended" role="status">{problem}</p>}
    <div className="launch-review-actions">
      <button type="button" className="button primary" disabled={busy || !!problem} onClick={onSign}>{busy ? 'Starting…' : coin.selectedHook && !selectedReady ? 'Check hook availability' : 'Sign and launch'}</button>
      {onEdit && <button type="button" className="button outline" disabled={busy} onClick={onEdit}>{editLabel}</button>}
    </div>
    <p className="form-fineprint">{coin.selectedHook ? !selectedReady ? 'Availability check only. Nothing will be signed.' : THREE_APPROVALS : TWO_APPROVALS}</p>
  </section>
}

// The one guided signing step: two wallet approvals, each confirmed on Solana before the next.
export function OpenLaunchSigning({ symbol, stage, status, busy, error, canRetry, onRetry, review, selectedHook }) {
  const second = stage === 'launch'
  const disclosureProblem = setupDisclosureProblem(stage, review, selectedHook)
  const tableCost = selectedHook && stage === 'hook-setup' && !disclosureProblem ? review?.supplementalTableCost : null
  const items = [...(selectedHook ? [['Approve hook setup', 'Sets up your chosen hook for this coin.']] : []), [selectedHook ? 'Approve launch configuration' : 'Approve the setup', 'Saves your coin settings and creates the required accounts.'], ['Approve the launch', 'Creates your coin and opens trading with your rules.']]
  const active = selectedHook ? stage === 'hook-setup' ? 0 : second ? 2 : 1 : second ? 1 : 0
  const statusText = ({
    'outcome-unknown': 'Your transaction is not yet confirmed. We are still checking; do not start another launch.',
    'submission-claimed': 'Sending your approved transaction…', submitted: 'Waiting for confirmation on Solana…',
    reviewed: 'Review the costs before requesting wallet approval.', partial: 'Finishing the approved transaction…',
    signed: 'Your approval is saved. Preparing to send…', expired: 'This review expired. A fresh review is needed before approval.',
    'signing-claimed': 'Finishing the approved transaction…', 'signing-unknown': 'We are checking your saved approval. Do not start another launch.',
    'finalized-success': 'This step is confirmed on Solana.', 'finalized-failure': 'This step failed on Solana. Check the details before continuing.',
    'review-required': 'This launch needs a manual check before you approve anything else.',
  })[status] ?? (/^[a-z]+(?:[-_][a-z]+)+$/.test(status ?? '') ? 'This launch needs a check before you approve anything else.' : status)
  return <section className="launch-panel hooks-open-signing" aria-labelledby="hooks-signing-title" aria-live="polite">
    <h2 id="hooks-signing-title">Launching ${symbol}</h2>
    <p className="launch-subtitle">{selectedHook ? THREE_APPROVALS : TWO_APPROVALS} Keep this page open until it says your coin is live.</p>
    <ol className="hooks-sign-steps hooks-open-progress" aria-label="Wallet approvals">{items.map(([label, about], index) => {
      const state = index < active ? 'done' : index === active ? 'current' : 'todo'
      return <li key={label} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
        <span>{state === 'done' ? <Check size={14} aria-hidden="true"/> : state === 'current' && busy ? <LoaderCircle size={14} className="image-picker-spinner" aria-hidden="true"/> : index + 1}</span>
        <div><strong>{label}</strong><small>{about}</small></div></li>
    })}</ol>
    {selectedHook && review && <div className="inner-card fee-breakdown" aria-label="Exact selected-hook transaction review">
      <p>Maximum wallet debit: <strong>{review.maxNativeDebitLamports} lamports</strong> (includes network fee).</p>
      {tableCost && <div role="note" aria-label="Permanent supplemental table cost">
        <p>Address table cost (rent): <strong>{tableCost.rentLamports} lamports</strong>, separate from the network fee and included in the maximum wallet debit above.</p>
        <p>This table lets your complete launch fit in one transaction. Your coin and its required accounts are created together.</p>
        <p>This setup creates and permanently freezes the supplemental address lookup table. Its rent cannot be reclaimed, its addresses cannot be changed, and the table cannot be closed.</p>
      </div>}
      {!disclosureProblem && <p>Continue requests your wallet approval for only this reviewed transaction. Any change requires a new review.</p>}
      <details><summary>Technical details</summary>
        <p>Selected hook <code style={{ overflowWrap: 'anywhere' }}>{selectedHook.program}</code> · Flags: {selectedHook.flags}</p>
        {tableCost && <p>Table address: <code style={{ overflowWrap: 'anywhere' }}>{tableCost.address}</code></p>}
        <p>Exact message SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{review.messageSha256}</code></p>
      </details>
    </div>}
    {disclosureProblem && <p className="inline-error" role="alert">{disclosureProblem}</p>}
    {status && <p className="hooks-operation-status" role="status">{statusText}</p>}
    {statusText !== status && <details><summary>Technical status</summary><p>{status}</p></details>}
    <HooksOperationError error={error}/>
    {canRetry && <button type="button" className="button primary" disabled={busy || !!disclosureProblem} onClick={onRetry}>{busy ? 'Working…' : 'Continue'}</button>}
  </section>
}

export function OpenLaunchLive({ symbol, mint, onAnother }) {
  return <section className="launch-panel hooks-status hooks-open-live" aria-live="polite">
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
  const running = useRef(false), idsRef = useRef(NO_IDS), consentRef = useRef(null)
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
      setCoin(current => step !== 'coin' ? current : ({ ...current, creatorFeeBps: menuChoice(value.openCreation?.creatorFeeBps, current.creatorFeeBps, current.creatorFeeBps),
        capBps: current.selectedHook || current.hookKind === 'selected' ? 0 : menuChoice(value.openCreation?.capBps, current.capBps, current.capBps) }))
      if (!session.signedIn) return
      const mine = await post(REQUESTS, { action: 'get' }); setRequest(mine.request ?? null)
    } catch (e) { if (!running.current) setError(e.message) }
  }, [session.signedIn, step])
  useEffect(() => { idsRef.current = readIds(); refresh(); const timer = setInterval(() => { if (!running.current) refresh() }, 30_000); return () => clearInterval(timer) }, [refresh])
  // A recorded coin that has not launched yet goes straight to its review; one mid-launch resumes its signing step.
  useEffect(() => {
    if (!request || running.current || step === 'live') return
    if (['queued', 'launching'].includes(request.status)) setCoin(current => ({ ...current, name: request.name, symbol: request.symbol, creatorFeeBps: request.creatorFeeBps, capBps: request.capBps, selectedHook: request.selectedHook, hookPublication: request.hookPublication, quoteCut: request.quoteCut, authorShareBps: request.authorShareBps, rules: request.rules, hookKind: request.selectedHook ? 'selected' : 'max-wallet' }))
    if (request.status === 'queued' || (request.selectedHook && !openCreation?.selectedHooksEnabled)) setStep('review')
    if (request.status === 'launching' && (!request.selectedHook || openCreation?.selectedHooksEnabled)) { setStep('sign'); setCanRetry(true); setStatus('Your launch is waiting for you. Continue to finish it.') }
  }, [request?.id, request?.status])

  const api = body => post(LAUNCH, body)
  // Every operation the server returns must be this wallet's, on this network, for this launch.
  const checked = (op, signingId) => {
    if (!op || op.id !== signingId || !['hook-setup', 'preparation', 'launch'].includes(op.stage) || op.review?.genesisHash !== genesisHash
      || op.review?.wallet !== walletRef.current || op.custodyOperationId !== idsRef.current.operationId) throw Error('This launch belongs to another wallet. Nothing was signed.')
    setOperation(op); return op
  }
  const review = async (stage, fresh = false) => {
    const key = stage === 'hook-setup' ? 'setupId' : stage === 'preparation' ? 'preparationId' : 'launchId', ids = idsRef.current
    const next = { ...ids, [key]: !fresh && ids[key] ? ids[key] : crypto.randomUUID() }; retain(next)
    return checked((await api({ action: 'review', operationId: next.operationId, signingId: next[key], stage })).operation, next[key])
  }
  // A recorded coin not bound to a launch yet gets a fresh operation; one already bound keeps it (and the signing IDs this
  // device kept for it). IDs from any other launch are never reused.
  const reserve = async current => {
    // A registry handoff or interrupted reserve can bind the request before its
    // response reaches this page. Recover that binding before allocating an ID.
    const latest = (await post(REQUESTS, { action: 'get' })).request
    if (!latest || latest.id !== current.id || !['queued', 'launching'].includes(latest.status)
      || latest.uri !== current.uri || latest.name !== current.name || latest.symbol !== current.symbol
      || !sameLaunchHook(latest, current)) throw Error('The recorded launch changed. Reload to recover it; nothing was signed.')
    current = latest; setRequest(current)
    const operationId = current.custodyOperationId ?? crypto.randomUUID()
    const ids = idsRef.current.operationId === operationId ? idsRef.current : { ...NO_IDS, operationId }
    retain(ids)
    const input = reservationInput({}, { name: current.name, symbol: current.symbol, uri: current.uri, creatorFeeBps: current.creatorFeeBps, capBps: current.capBps, selectedHook: current.selectedHook, hookPublication: current.hookPublication,
      quoteCut: current.quoteCut, authorShareBps: current.authorShareBps, rules: current.rules })
    const value = await api({ action: 'reserve', operationId: ids.operationId, ...input })
    if (value.operationId !== ids.operationId || !value.mint) throw Error('The launch changed while it was starting. Nothing was signed.')
    setMint(value.mint); if (value.pricing) setPricing(value.pricing)
  }
  const signStep = async op => {
    const problem = setupDisclosureProblem(op.stage, op.review, request?.selectedHook || coin.selectedHook)
    if (problem) throw Error(problem)
    const walletRequest = await api({ action: 'wallet-request', signingId: op.id })
    const signedTransactionBase64 = await signReviewedLaunch({ walletRequest, reviewed: op.review, address: walletRef.current, genesisHash, currentWallet: () => walletRef.current, adapter: provider() })
    return checked((await api({ action: 'retain-wallet', signingId: op.id, signedTransactionBase64 })).operation, op.id)
  }
  // Drives the launch to live: each move is what the last server answer calls for (nextOpenLaunchAction).
  async function drive(current) {
    let op = operation
    const resumeId = idsRef.current.launchId || idsRef.current.preparationId || idsRef.current.setupId
    if (!op && current.status === 'launching' && uuid(resumeId))
      op = await review(idsRef.current.launchId ? 'launch' : idsRef.current.preparationId ? 'preparation' : 'hook-setup')
    for (let moves = 0; moves < 400; moves++) {
      const action = nextOpenLaunchAction(op, { wallet: walletRef.current })
      setStatus(openLaunchStatus(op, action))
      if (action === 'reserve') { await reserve(current); op = await review(current.selectedHook ? 'hook-setup' : 'preparation'); continue }
      if (action === 'sign') {
        const problem = setupDisclosureProblem(op.stage, op.review, current.selectedHook)
        if (problem) throw Error(problem)
        if(current.selectedHook && consentRef.current !== op.review.messageSha256){
          setCanRetry(true); setStatus('Review the costs and settings above, then Continue to request your wallet approval.'); return
        }
        consentRef.current=null; op = await signStep(op); continue
      }
      if (['cosign', 'submit', 'refresh'].includes(action)) { op = checked((await api({ action: action === 'refresh' ? 'refresh-review' : action, signingId: op.id })).operation, op.id); continue }
      if (action === 'close') { op = checked((await api({ action: 'expire', signingId: op.id })).operation, op.id); continue }
      if (action === 'reconcile' || action === 'wait') { await sleep(4000); op = checked((await api({ action: action === 'wait' ? 'get' : 'reconcile', signingId: op.id })).operation, op.id); continue }
      if (action === 'fresh') { op = await review(op.stage, true); continue }
      if (action === 'preparation') { op = await review('preparation'); continue }
      if (action === 'launch') { op = await review('launch'); continue }
      if (action === 'live') { setStep('live'); setStatus(''); return }
      throw Error('This launch needs a check before anything else is signed. Keep this page and your recovery IDs; nothing more will be signed.')
    }
  }
  const signAndLaunch = async () => {
    if (running.current) return
    consentRef.current=step==='sign'&&operation?.status==='reviewed'&&request?.selectedHook?operation.review.messageSha256:null
    running.current = true; setBusy(true); setError(''); setCanRetry(false)
    try {
      if (!session.signedIn && !await session.signIn()) return
      let current = request && ['queued', 'launching'].includes(request.status) ? request : null
      if (current && (coin.selectedHook || current.selectedHook || coin.hookKind === 'selected') && !sameLaunchHook(coin, current)) throw Error('The recorded hook configuration differs. Reload to recover the original launch; nothing was signed.')
      if (!current) {
        const problem = coinProblem(coin) || openCreationProblem(openCreation); if (problem) throw Error(problem)
        const created = await post(REQUESTS, { action: 'create', requestId: crypto.randomUUID(), name: coin.name.trim(), symbol: coin.symbol, image: coin.image,
          description: coin.description, x: coin.x, website: coin.website, telegram: coin.telegram, creatorFeeBps: coin.creatorFeeBps, ...launchHookInput(coin) })
        if ((coin.selectedHook || created.request?.selectedHook || coin.hookKind === 'selected') && !sameLaunchHook(coin, created.request))
          throw Error('The recorded hook configuration differs. Reload to recover the original launch; nothing was signed.')
        current = created.request; setRequest(current)
      }
      if (current.selectedHook && !openCreation?.selectedHooksEnabled) {
        // Recording survives a refresh, but neither a successful availability response nor recovery
        // can enter signing until the selected-hook review boundary is implemented and adopted.
        if (!sameLaunchHook(coin, current)) throw Error('The recorded hook configuration differs. Reload to recover the original launch; nothing was signed.')
        if (current.status === 'launching') throw Error(SELECTED_HOOK_NOTE)
        await reserve(current)
        throw Error(SELECTED_HOOK_NOTE)
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
      retain(NO_IDS); setOperation(null); setMint(null); setPricing(null); setCoin(current => ({ ...EMPTY_COIN, creatorFeeBps: current.creatorFeeBps, capBps: defaultOpenChoices(openCreation).capBps })); setStep('coin') }
    catch (e) { setError(e.message) } finally { running.current = false; setBusy(false) }
  }
  const toReview = event => {
    event.preventDefault()
    const problem = coinProblem(coin) || openCreationProblem(openCreation)
    if (problem) { setError(problem); return }
    try { launchHookInput(coin) } catch (e) { setError(e.message); return }
    setError(''); setStep('review')
  }

  const recorded = request && ['queued', 'launching', 'launched'].includes(request.status) ? request : null
  const shown = recorded && step !== 'coin' ? recorded : { ...coin, name: coin.name.trim() }
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
          <HookCoinPreview image={coin.image} name={coin.name.trim()} symbol={coin.symbol} capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} selectedHook={coin.selectedHook} profile={previewProfile(coin)}/>
          <HookCoinFields form={coin} set={set} disabled={busy} onImageBusy={setImageBusy} menus={menus} allowSelectedHook/>
        </fieldset>
        <div className="launch-side"><HookLaunchNotes capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} selectedHook={coin.selectedHook} launchPrice={availability?.launchPrice} open/></div>
      </div>
      <HooksOperationError error={error || session.error}/>
      <button type="submit" className="button primary launch-submit" disabled={busy || imageBusy}>{imageBusy ? 'Preparing image…' : 'Review your launch'}</button>
      <p className="form-fineprint">Nothing is created or signed until you approve it in your wallet.</p>
    </form>}
    {step === 'review' && <>
      {!session.signedIn && session.checked && <HookWalletSignIn genesisHash={genesisHash} session={session} title="Sign in to launch">Sign in with the wallet that will own this coin. It’s free and sends no transaction.</HookWalletSignIn>}
      <OpenLaunchReview coin={shown} image={image} profile={recorded?.profile ?? previewProfile(coin)} openCreation={openCreation} costs={availability?.costs} price={pricing ?? recorded?.pricing ?? availability?.launchPrice}
        busy={busy || session.busy} onSign={signAndLaunch} onEdit={recorded?.status === 'queued' ? startOver : () => setStep('coin')} editLabel={recorded?.status === 'queued' ? 'Start over' : 'Edit'}/>
      <HooksOperationError error={error}/>
    </>}
    {step === 'sign' && <><HookEconomicsReview coin={shown}/><OpenLaunchSigning symbol={shown.symbol} stage={operation?.stage} status={status} busy={busy} error={error} canRetry={canRetry} onRetry={signAndLaunch} review={operation?.review} selectedHook={shown.selectedHook}/></>}
    {step === 'live' && <OpenLaunchLive symbol={shown.symbol} mint={mint ?? recorded?.mint} onAnother={startOver}/>}
    {step === 'sign' && <details className="launch-customize hooks-recovery"><summary><span>Recovery IDs</span><ChevronDown size={18} aria-hidden="true"/></summary>
      <div className="launch-customize-body"><p>If the page reloads, these pick up the same launch on this device. Never start a second launch to get around an unclear result.</p>
        <dl className="hooks-recovery-ids">{Object.entries({ operationId: 'Launch', ...(shown.selectedHook ? { setupId: 'Hook setup approval' } : {}), preparationId: 'Config preparation approval', launchId: 'Launch approval' }).map(([key, label]) =>
          <div key={key}><dt>{label}</dt><dd><code>{idsRef.current[key] || '—'}</code></dd></div>)}</dl></div></details>}
  </div>
}
