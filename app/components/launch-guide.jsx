'use client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { GithubMark } from './github-mark'
import { useWallet } from './wallet'
import { ScheduledLaunchBlocked } from './scheduled-launch'
import { PreflightQuality, PreflightRequirements, PreflightVerdict } from './preflight-report'
import { GUIDE_EVENTS_ENDPOINT, GUIDE_STEPS } from '../lib/launch-guide-funnel.mjs'

// The guided launch (docs/LAUNCH_GUIDE.md): GitHub → repository → preflight → plan → disclose → preview → publish. Drafts are saved
// on the server for the signed-in GitHub account at each step and resumed from /launches/new?draft=<id> or the repository list;
// this browser also remembers the open draft so a GitHub sign-in round trip comes back to it. Nothing is published before the
// last step, which writes the same public scheduled launch as /launches/manage.
const APP_ACCESS_URL = 'https://github.com/apps/repo-ing/installations/new'
const STORAGE_KEY = 'repoing:launch-guide'
const STEP_TITLES = { github: 'Connect GitHub', repository: 'Choose a repository', preflight: 'Preflight', plan: 'Plan the launch', disclose: 'Disclose',
  preview: 'Preview', publish: 'Publish' }
const REQUEST_TIMEOUT_MS = 45_000
const sol = lamports => (lamports === null || lamports === undefined ? '—' : `${(Number(BigInt(lamports)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`)
const utc = value => (value ? `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '—')
const short = value => (value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '—')
const toLocalInput = iso => { const date = new Date(iso); return new Date(date - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
const defaultTime = () => { const date = new Date(Date.now() + 24 * 3_600_000); date.setMinutes(0, 0, 0); return date.toISOString() }

function remember(value) { try { if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else localStorage.removeItem(STORAGE_KEY) } catch {} }
function remembered() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') } catch { return null } }
// Global Privacy Control or Do Not Track: send nothing.
const trackingAllowed = () => { try { return !(navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') } catch { return false } }
function beacon(body) {
  if (!trackingAllowed()) return
  const text = JSON.stringify(body)
  try { if (!navigator.sendBeacon?.(GUIDE_EVENTS_ENDPOINT, text)) void fetch(GUIDE_EVENTS_ENDPOINT, { method: 'POST', body: text, keepalive: true }).catch(() => {}) } catch {}
}

class RequestError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body }
}
async function call(url, { method = 'GET', body } = {}) {
  let response
  try {
    response = await fetch(url, { method, cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  } catch (error) {
    throw new RequestError(error?.name === 'TimeoutError' ? 'GitHub or repo.ing took too long to answer. Nothing was lost: try again.' : 'Could not reach repo.ing. Check your connection and try again.', 0, null)
  }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new RequestError(result.error || 'Something went wrong. Try again.', response.status, result)
  return result
}

// One async operation's state: { busy, error, retry }.
function useOperation() {
  const [state, setState] = useState({ busy: false, error: null, retry: null })
  const run = useCallback(async (work, retry = null) => {
    setState({ busy: true, error: null, retry: null })
    try { const result = await work(); setState({ busy: false, error: null, retry: null }); return result }
    catch (error) { setState({ busy: false, error, retry }); return null }
  }, [])
  const clear = useCallback(() => setState({ busy: false, error: null, retry: null }), [])
  return [state, run, clear]
}

function ErrorCard({ state, onSignIn }) {
  if (!state.error) return null
  const signIn = state.error.status === 401
  return <div className="state-card error guide-error" role="alert"><p>{state.error.message}</p>
    <div className="guide-actions">{signIn ? <a className="button outline" href={onSignIn}><GithubMark size={16}/>Sign in with GitHub again</a>
      : state.retry && <button type="button" className="button outline" onClick={state.retry}><RefreshCw size={14} aria-hidden="true"/>Try again</button>}</div></div>
}

export function LaunchGuide({ signedIn, githubLogin, initialRepo, initialDraftId, source, errorMessage, schedulingEnabled, rules }) {
  const saved = useMemo(() => (typeof window === 'undefined' ? null : remembered()), [])
  const src = source ?? saved?.src ?? null
  const signInHref = `/api/github/start?mode=launch-guide${src ? `&src=${src}` : ''}`
  const [step, setStep] = useState(signedIn ? 'repository' : 'github')
  const [draft, setDraft] = useState(null)
  const [preflight, setPreflight] = useState(null)
  const [repository, setRepository] = useState(null)
  const [plan, setPlan] = useState(null)
  const [account, setAccount] = useState({ drafts: null, repositories: null, githubLogin })
  const [selection, setSelection] = useState(null) // a refused selection: { repoId, fullName, maintainer }
  const [published, setPublished] = useState(null)
  const [loadState, runLoad] = useOperation()
  const [selectState, runSelect] = useOperation()
  const [checkState, runCheck] = useOperation()
  const [saveState, runSave] = useOperation()
  const [publishState, runPublish] = useOperation()
  const heading = useRef(null), shownStep = useRef(step)

  // Analytics: a page view, then each step shown (fixed lists only; app/lib/launch-guide-funnel.mjs).
  useEffect(() => { beacon({ event: 'guide_view', source: src, repoId: /^[1-9]\d{0,15}$/.test(initialRepo ?? '') ? initialRepo : null }) }, [src, initialRepo])
  // A signed-in visit first resumes a draft or lists repositories; the step it settles on is the one counted.
  const [settled, setSettled] = useState(!signedIn)
  useEffect(() => {
    if (settled) beacon({ event: 'step_view', step, source: src, repoId: draft?.repoId ?? null })
    // Focus follows a step change (not the first render), so keyboard and screen reader users land on the new step.
    if (shownStep.current === step) return
    shownStep.current = step
    heading.current?.focus()
  }, [step, settled]) // eslint-disable-line react-hooks/exhaustive-deps

  const adopt = useCallback((next, { goTo } = {}) => {
    setDraft(next)
    if (next?.preflight) setPreflight(next.preflight)
    setPlan(current => current && current.draftId === next.id ? current : { draftId: next.id, ...{ scheduledAt: defaultTime(), windowMinutes: rules.defaultWindowMinutes, supplyBps: 0 }, ...next.plan })
    remember({ draftId: next.id, src })
    try { const url = new URL(window.location.href); url.searchParams.set('draft', next.id); url.searchParams.delete('error'); url.searchParams.delete('verified'); window.history.replaceState(null, '', url) } catch {}
    if (goTo) setStep(goTo)
  }, [rules.defaultWindowMinutes, src])

  const check = useCallback(async (draftId, { planToSave, refresh = false, goTo } = {}) => {
    const result = await runCheck(() => call('/api/launch-guide', { method: 'POST', body: { action: 'check', draftId, ...(planToSave ? { plan: planToSave } : {}), refresh, source: src } }),
      () => check(draftId, { planToSave, refresh, goTo }))
    if (result) { setPreflight(result.preflight); setRepository(result.repository); adopt(result.draft, { goTo }) }
    return result
  }, [adopt, runCheck, src])

  const load = useCallback(async () => {
    const result = await runLoad(() => call('/api/launch-guide?repositories=1'), () => load())
    if (result) setAccount({ drafts: result.drafts ?? [], repositories: result.repositories ?? [], githubLogin: result.githubLogin })
  }, [runLoad])

  // Resume: ?draft=, then the draft this browser remembers; otherwise list the account's repositories and drafts.
  useEffect(() => {
    if (!signedIn) return
    const resume = initialDraftId ?? saved?.draftId ?? null
    if (resume) {
      void (async () => {
        const result = await runCheck(() => call('/api/launch-guide', { method: 'POST', body: { action: 'check', draftId: resume, source: src } }), () => window.location.reload())
        if (result) { setPreflight(result.preflight); setRepository(result.repository); adopt(result.draft, { goTo: result.draft.status === 'published' ? 'publish' : result.draft.step }) }
        else { remember(null); void load() }
        setSettled(true)
      })()
    } else { void load(); setSettled(true) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const select = async repo => {
    setSelection(null)
    const result = await runSelect(() => call('/api/launch-guide', { method: 'POST', body: { action: 'select', repoId: repo.repoId, source: src } }), () => select(repo))
    if (!result) return
    if (!result.draft) { setSelection({ ...repo, maintainer: result.maintainer }); return }
    await check(result.draft.id, { goTo: 'preflight' })
  }

  const saveStep = async (next, extra = {}) => {
    if (!draft) return null
    const body = { action: 'save', draftId: draft.id, step: next, ...(extra.plan ? { plan: extra.plan } : {}) }
    const result = await runSave(() => call('/api/launch-guide', { method: 'POST', body }), () => saveStep(next, extra))
    if (result) adopt(result.draft, { goTo: next })
    return result
  }

  const planBody = current => ({ scheduledAt: current.scheduledAt, windowMinutes: Number(current.windowMinutes), launcherWallet: current.launcherWallet ?? '',
    supplyBps: Number(current.supplyBps ?? 0), note: current.note ?? '', tokenName: current.tokenName ?? '', tokenSymbol: current.tokenSymbol ?? '',
    acknowledged: Boolean(current.acknowledged) })

  const goTo = target => {
    if (target === 'plan' && step !== 'plan') return void saveStep('plan')
    if (target === 'retry' && draft) return void check(draft.id, { refresh: true })
    setStep(target)
  }

  const publish = async () => {
    const result = await runPublish(async () => {
      try { return await call('/api/launch-guide', { method: 'POST', body: { action: 'publish', draftId: draft.id, source: src } }) }
      catch (error) {
        // A refused publish carries the preflight that refused it, so the page shows exactly what is missing.
        if (error.body?.detail?.preflight) setPreflight(error.body.detail.preflight)
        throw error
      }
    }, () => publish())
    if (result) { setPublished(result.schedule); adopt(result.draft, { goTo: 'publish' }); remember(null) }
  }

  const reached = useMemo(() => {
    const order = GUIDE_STEPS.indexOf(draft?.step ?? (signedIn ? 'repository' : 'github'))
    return new Set(GUIDE_STEPS.filter((name, index) => index <= Math.max(order, GUIDE_STEPS.indexOf(step))))
  }, [draft?.step, signedIn, step])
  const locked = draft?.status === 'published'

  return <div className="launch-guide">
    {errorMessage && <p className="inline-error" role="alert">{errorMessage}</p>}
    <nav aria-label="Launch steps" className="guide-steps"><ol>{GUIDE_STEPS.map((name, index) => {
      const current = name === step
      const available = !locked && reached.has(name) && (name === 'github' || name === 'repository' || draft)
      return <li key={name} className={current ? 'is-current' : reached.has(name) ? 'is-done' : ''}>
        {available && !current ? <button type="button" onClick={() => setStep(name)}><span aria-hidden="true">{index + 1}</span>{STEP_TITLES[name]}</button>
          : <span aria-current={current ? 'step' : undefined}><span aria-hidden="true">{index + 1}</span>{STEP_TITLES[name]}</span>}</li>
    })}</ol></nav>
    {draft && <p className="guide-saved" role="status">{locked ? 'Published' : 'Draft saved'} · {draft.fullName ?? repository?.fullName ?? `Repository ${draft.repoId}`} · {utc(draft.updatedAt)}</p>}

    <section className="inner-card guide-step" aria-labelledby="guide-step-title">
      <h2 id="guide-step-title" ref={heading} tabIndex={-1}>{STEP_TITLES[step]}</h2>
      {step === 'github' && <GithubStep signedIn={signedIn} githubLogin={account.githubLogin} signInHref={signInHref} initialRepo={initialRepo} source={src}
        onContinue={() => { setStep('repository'); if (!account.repositories) void load() }}/>}
      {step === 'repository' && <RepositoryStep account={account} loadState={loadState} selectState={selectState} selection={selection} signInHref={signInHref}
        onRefresh={load} onSelect={select} onResume={item => check(item.id, { goTo: item.step })} checking={checkState.busy} highlight={initialRepo}/>}
      {step === 'preflight' && <>
        <ErrorCard state={checkState} onSignIn={signInHref}/>
        {preflight ? <PreflightStep preflight={preflight} repository={repository} busy={checkState.busy} onAction={goTo}
          onRefresh={() => check(draft.id, { refresh: true })} onContinue={() => saveStep('plan')} saving={saveState.busy}/> : <p role="status">Running the preflight…</p>}
      </>}
      {step === 'plan' && plan && <PlanStep plan={plan} setPlan={setPlan} preflight={preflight} rules={rules} schedulingEnabled={schedulingEnabled} busy={checkState.busy || saveState.busy}
        state={checkState.error ? checkState : saveState} signInHref={signInHref}
        onCheck={async () => { await check(draft.id, { planToSave: planBody(plan) }) }}
        onContinue={async () => { const result = await check(draft.id, { planToSave: planBody(plan) }); if (result && planReady(result.preflight)) await saveStep('disclose') }}/>}
      {step === 'disclose' && preflight && <DiscloseStep preflight={preflight} plan={plan} busy={saveState.busy} state={saveState} signInHref={signInHref}
        onContinue={async acknowledged => { const next = { ...plan, acknowledged }; setPlan(next); await saveStep('preview', { plan: planBody(next) }) }}/>}
      {step === 'preview' && preflight && <PreviewStep preflight={preflight} plan={plan} draft={draft} repository={repository} busy={saveState.busy} state={saveState} signInHref={signInHref}
        onContinue={() => saveStep('publish')}/>}
      {step === 'publish' && <PublishStep preflight={preflight} plan={plan} draft={draft} published={published} state={publishState} signInHref={signInHref}
        onPublish={publish} onAction={goTo}/>}
    </section>
  </div>
}

const planReady = preflight => preflight.requirements.filter(item => item.group === 'Plan' && item.requiredFor.includes('schedule')).every(item => item.status === 'met' || item.status === 'warn')

function GithubStep({ signedIn, githubLogin, signInHref, initialRepo, source, onContinue }) {
  const [input, setInput] = useState(initialRepo ?? '')
  const [result, setResult] = useState(null)
  const [state, run] = useOperation()
  const preflight = async event => {
    event?.preventDefault()
    const value = input.trim()
    if (!value) return
    const data = await run(() => call(`/api/launch-preflight?repo=${encodeURIComponent(value)}${source ? `&src=${source}` : ''}`), () => preflight())
    if (data) setResult(data)
  }
  useEffect(() => { if (initialRepo && !signedIn) void preflight() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="guide-body">
    {signedIn ? <div className="guide-account"><p><GithubMark size={17}/> Signed in as <strong>{githubLogin}</strong>.</p>
      <button type="button" className="button primary" onClick={onContinue}>Choose a repository</button></div>
      : <div className="guide-account"><p>Maintainers sign in with GitHub to schedule a launch. It is read-only: it tells repo.ing who you are and which public repositories you administer. It grants no access to your code, and repo.ing never asks for a seed phrase.</p>
        <a className="button primary" href={signInHref}><GithubMark size={18}/>Sign in with GitHub</a></div>}
    <form className="guide-preflight-form" onSubmit={preflight} role="search" aria-label="Preflight any repository">
      <label htmlFor="guide-repo-input">Or run a free preflight on any public repository, no sign-in</label>
      <div><input id="guide-repo-input" value={input} onChange={event => setInput(event.target.value)} placeholder="owner/name or https://github.com/owner/name"
        autoComplete="off" spellCheck={false} aria-describedby="guide-repo-hint"/>
        <button type="submit" className="button outline" disabled={state.busy || !input.trim()}>{state.busy ? 'Checking…' : 'Run preflight'}</button></div>
      <small id="guide-repo-hint">Reads public GitHub facts and repo.ing&apos;s records. Nothing is saved or published.</small>
    </form>
    <ErrorCard state={state} onSignIn={signInHref}/>
    {result && <div className="guide-anon-result" aria-live="polite">
      <h3>{result.repository?.fullName ?? 'Repository'}</h3>
      <PreflightVerdict preflight={result.preflight}/>
      <PreflightQuality quality={result.preflight.quality} checkedAt={result.preflight.checkedAt}/>
      <section className="inner-card transparency-card" aria-labelledby="anon-req-title"><h3 id="anon-req-title">Requirements</h3>
        <PreflightRequirements preflight={result.preflight} onAction={() => preflight()} actions={['retry']}/></section>
      {!signedIn && <p className="guide-note">Maintainer of {result.repository?.fullName ?? 'this repository'}? <a href={signInHref}>Sign in with GitHub</a> to plan and schedule its launch.</p>}
    </div>}
  </div>
}

function RepositoryStep({ account, loadState, selectState, selection, signInHref, onRefresh, onSelect, onResume, checking, highlight }) {
  const [filter, setFilter] = useState('')
  // A link that named a repository (?repo=<id or owner/name>) lists it first.
  const named = repo => Boolean(highlight) && (repo.repoId === highlight || (repo.fullName ?? '').toLowerCase() === String(highlight).toLowerCase())
  const repos = (account.repositories ?? []).filter(repo => !filter || (repo.fullName ?? '').toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Number(named(b)) - Number(named(a)))
  const drafts = account.drafts ?? []
  return <div className="guide-body">
    <ErrorCard state={loadState} onSignIn={signInHref}/>
    {drafts.length > 0 && <div><h3 className="guide-subtitle">Continue where you left off</h3><ul className="guide-list">{drafts.map(item => <li key={item.id}>
      <span><strong>{item.fullName ?? `Repository ${item.repoId}`}</strong><small>{STEP_TITLES[item.step]} · saved {utc(item.updatedAt)}</small></span>
      <button type="button" className="button outline" onClick={() => onResume(item)} disabled={checking}>Continue</button></li>)}</ul></div>}
    <h3 className="guide-subtitle">Repositories you administer</h3>
    <div className="guide-toolbar"><label className="guide-filter">Filter<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="owner/name"/></label>
      <button type="button" className="button outline" onClick={onRefresh} disabled={loadState.busy}><RefreshCw size={14} aria-hidden="true"/>{loadState.busy ? 'Checking GitHub…' : 'Refresh'}</button></div>
    {loadState.busy && !account.repositories && <p role="status">Checking your GitHub repositories…</p>}
    {account.repositories && !account.repositories.length && <p className="launches-empty">No public repositories you administer are shared with repo.ing&apos;s read-only GitHub App. <a href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">Give it access ↗</a>, then refresh.</p>}
    <ErrorCard state={selectState} onSignIn={signInHref}/>
    {selection && <div className="state-card error guide-error" role="alert"><p><strong>{selection.fullName ?? `Repository ${selection.repoId}`}:</strong>{' '}
      {selection.maintainer.status === 'not-admin' ? `GitHub reports ${selection.maintainer.githubLogin} with ${selection.maintainer.permission && selection.maintainer.permission !== 'none' ? `${selection.maintainer.permission} access` : 'no admin access'}. Only a current admin can schedule its launch.`
        : selection.maintainer.status === 'no-access' ? 'repo.ing\'s read-only GitHub App cannot see this repository for your account.' : 'GitHub did not confirm your access just now.'}</p>
      <div className="guide-actions">{selection.maintainer.status === 'no-access' ? <a className="button outline" href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">Give the App access ↗</a>
        : <button type="button" className="button outline" onClick={() => onSelect(selection)}>Check again</button>}</div></div>}
    {repos.length > 0 && <ul className="guide-list">{repos.map(repo => {
      const state = repo.mint ? 'Has a market' : repo.launchInProgress ? 'Launch in progress' : repo.optedOut ? 'Opted out' : repo.schedule ? `Scheduled ${utc(repo.schedule.scheduledAt)}` : 'No market yet'
      return <li key={repo.repoId}><span><strong>{repo.fullName ?? `Repository ${repo.repoId}`}</strong><small>{state}</small></span>
        {repo.mint ? <Link className="button outline" href={`/token/${repo.mint}`}>Open market</Link>
          : repo.schedule ? <Link className="button outline" href={`/launches#schedule-${repo.schedule.id}`}>View schedule</Link>
            : <button type="button" className="button outline" onClick={() => onSelect(repo)} disabled={selectState.busy || checking}
              aria-label={`Select ${repo.fullName ?? repo.repoId} and run its preflight`}>{selectState.busy ? 'Checking…' : 'Select'}</button>}</li>
    })}</ul>}
    <p className="guide-note">Not listed? You must be a current admin, and the repository must be shared with repo.ing&apos;s GitHub App (Metadata: read only). <a href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">Manage GitHub access ↗</a></p>
  </div>
}

function PreflightStep({ preflight, repository, busy, onAction, onRefresh, onContinue, saving }) {
  return <div className="guide-body" aria-busy={busy}>
    {repository && <p className="guide-note">{repository.fullName}{repository.description ? `: ${repository.description}` : ''}</p>}
    <PreflightVerdict preflight={preflight}/>
    <PreflightQuality quality={preflight.quality} checkedAt={preflight.checkedAt}/>
    <section className="inner-card transparency-card" aria-labelledby="req-title"><h3 id="req-title">Requirements</h3>
      <p className="transparency-lede">Each requirement says what was checked and, when it is not met, exactly what to do.</p>
      <PreflightRequirements preflight={preflight} onAction={onAction} only={['Repository', 'Maintainer', 'Market']}/></section>
    <div className="guide-actions">
      <button type="button" className="button outline" onClick={onRefresh} disabled={busy}><RefreshCw size={14} aria-hidden="true"/>{busy ? 'Checking…' : 'Run again'}</button>
      <button type="button" className="button primary" onClick={onContinue} disabled={busy || saving || preflight.verdict === 'blocked'}>{saving ? 'Saving…' : 'Plan the launch'}</button>
    </div>
    {preflight.verdict === 'blocked' && <p className="guide-note">This repository cannot launch right now. Fix the blocked items and run the preflight again; your draft is kept for 30 days.</p>}
  </div>
}

function PlanStep({ plan, setPlan, preflight, rules, schedulingEnabled, busy, state, signInHref, onCheck, onContinue }) {
  const { wallet } = useWallet() ?? {}
  const set = key => event => setPlan(current => ({ ...current, [key]: event.target.value }))
  const options = preflight?.buyOptions ?? [{ bps: 0, lamports: '0' }]
  const requirement = id => preflight?.requirements.find(item => item.id === id)
  const error = id => { const item = requirement(id); return item && ['missing', 'blocked', 'unknown'].includes(item.status) ? item.detail : null }
  const localValue = plan.scheduledAt ? toLocalInput(plan.scheduledAt) : ''
  if (!schedulingEnabled) return <p className="guide-note">Scheduling new launches is paused right now. Your draft is saved; come back later.</p>
  return <form className="guide-body launch-manage-form guide-plan" onSubmit={event => { event.preventDefault(); void onContinue() }} noValidate>
    <label>Launch time (your time zone)<input type="datetime-local" required value={localValue} aria-invalid={Boolean(error('launch_time'))} aria-describedby="plan-time-hint"
      onChange={event => setPlan(current => ({ ...current, scheduledAt: event.target.value ? new Date(event.target.value).toISOString() : '' }))}/>
      <small id="plan-time-hint">{plan.scheduledAt ? utc(plan.scheduledAt) : ''} · at least {rules.minNoticeMinutes} minutes and at most {rules.maxAheadDays} days ahead.</small>
      {error('launch_time') && <span className="inline-error">{error('launch_time')}</span>}</label>
    <label>Window (minutes)<input type="number" min={rules.minWindowMinutes} max={rules.maxWindowMinutes} step="1" required value={plan.windowMinutes ?? rules.defaultWindowMinutes}
      onChange={set('windowMinutes')} aria-describedby="plan-window-hint"/><small id="plan-window-hint">Only your wallet can launch during the window. If it has not launched by the end, anyone can.</small></label>
    <fieldset className="wide guide-buy"><legend>Initial buy in the launch transaction</legend>
      {options.map(option => <label key={option.bps}><input type="radio" name="supplyBps" value={option.bps} checked={Number(plan.supplyBps ?? 0) === option.bps}
        onChange={() => setPlan(current => ({ ...current, supplyBps: option.bps }))}/>{option.bps === 0 ? 'No initial buy' : `${option.bps / 100}% of supply`}
        {option.bps > 0 && <small>{option.lamports ? `about ${sol(option.lamports)}` : 'price unavailable'}</small>}</label>)}
      <small className="wide">Announced publicly with the schedule. The launch can buy no more; it pays the regular fee. Default: no buy.</small>
      {error('initial_buy') && <span className="inline-error">{error('initial_buy')}</span>}</fieldset>
    <label className="wide">Wallet that signs the launch<input required spellCheck={false} autoComplete="off" placeholder="Solana address" value={plan.launcherWallet ?? ''}
      onChange={set('launcherWallet')} aria-invalid={Boolean(error('launcher_wallet'))} aria-describedby="plan-wallet-hint"/>
      <small id="plan-wallet-hint">Published with the schedule. {typeof wallet === 'string' && wallet !== plan.launcherWallet && <button type="button" className="guide-link-button"
        onClick={() => setPlan(current => ({ ...current, launcherWallet: wallet }))}>Use connected wallet {short(wallet)}</button>}</small>
      {error('launcher_wallet') && <span className="inline-error">{error('launcher_wallet')}</span>}</label>
    <label>Token name (optional)<input maxLength={32} value={plan.tokenName ?? ''} onChange={set('tokenName')} aria-describedby="plan-token-hint"/></label>
    <label>Ticker (optional)<input maxLength={10} value={plan.tokenSymbol ?? ''} onChange={set('tokenSymbol')} aria-invalid={Boolean(error('token_identity'))} aria-describedby="plan-token-hint"/>
      {error('token_identity') && <span className="inline-error">{error('token_identity')}</span>}</label>
    <small id="plan-token-hint" className="wide">Not part of the announcement; you choose the name, ticker and image on the launch page. The ticker is checked now so you can pick a free one.</small>
    <label className="wide">Public note (optional, 280 characters, links only to github.com)<textarea maxLength={280} value={plan.note ?? ''} onChange={set('note')}/>
      {error('note') && <span className="inline-error">{error('note')}</span>}</label>
    {preflight && <div className="wide"><PreflightRequirements preflight={preflight} only={['Plan']} onAction={null}/></div>}
    <ErrorCard state={state} onSignIn={signInHref}/>
    <div className="wide guide-actions"><button type="button" className="button outline" onClick={onCheck} disabled={busy}>{busy ? 'Checking…' : 'Save and check'}</button>
      <button type="submit" className="button primary" disabled={busy}>{busy ? 'Checking…' : 'Continue to disclosures'}</button></div>
  </form>
}

function SeedingTable({ preflight }) {
  return <div className="transparency-table-wrap"><table className="transparency-table">
    <caption className="sr-only">What is seeded at launch and how it is locked</caption>
    <thead><tr><th scope="col">What</th><th scope="col">Wallet</th><th scope="col">Amount</th><th scope="col">Lock state</th></tr></thead>
    <tbody>{preflight.seeding.map(row => <tr key={row.kind}><th scope="row">{row.label}</th><td>{row.wallet ? <code title={row.wallet}>{short(row.wallet)}</code> : '—'}</td>
      <td>{row.percentOfSupply !== null && row.percentOfSupply !== undefined ? `${row.kind === 'launch-buy' && row.percentOfSupply > 0 ? 'up to ' : ''}${row.percentOfSupply}% of supply` : '—'}
        {row.solLamports && BigInt(row.solLamports) > 0n ? <small>{sol(row.solLamports)}</small> : null}</td><td>{row.lockText}</td></tr>)}</tbody></table></div>
}

function Controls({ preflight }) {
  return <ul className="transparency-criteria compact guide-controls">{preflight.controls.map(control => <li key={control.id}><span className="transparency-status">On</span>
    <div><strong>{control.label}</strong><p>{control.value}</p><small>Enforced by: {control.enforcedBy}</small></div></li>)}</ul>
}

function DiscloseStep({ preflight, plan, busy, state, signInHref, onContinue }) {
  const [acknowledged, setAcknowledged] = useState(Boolean(plan?.acknowledged))
  return <div className="guide-body">
    <p className="transparency-lede">What will be in the market at launch, who holds it and how it is locked. The launching wallet and its maximum buy are published with your schedule; after launch the market&apos;s Launch quality report shows each position with its lock state from on-chain evidence.</p>
    <h3 className="guide-subtitle">Seeded liquidity, wallets and lock states</h3>
    <SeedingTable preflight={preflight}/>
    <h3 className="guide-subtitle">Launch controls</h3>
    <p className="transparency-lede">Supported by the current system and enforced for every wallet, yours included. They are not optional and cannot be loosened.</p>
    <Controls preflight={preflight}/>
    <ul className="transparency-note">{preflight.quality.disclosures.map(item => <li key={item}>{item}</li>)}</ul>
    <label className="guide-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/>
      I understand the launch is public, my initial buy is not locked, the score is a description and not a rating, and a community market does not need my endorsement.</label>
    <ErrorCard state={state} onSignIn={signInHref}/>
    <div className="guide-actions"><button type="button" className="button primary" disabled={!acknowledged || busy} onClick={() => onContinue(acknowledged)}>{busy ? 'Saving…' : 'Preview the public page'}</button></div>
  </div>
}

// The schedule as it will be published, for the same components the public pages render.
function previewSchedule({ preflight, plan, draft, repository }) {
  const at = plan?.scheduledAt ?? new Date(Date.now() + 2 * 3_600_000).toISOString()
  const windowMinutes = Number(plan?.windowMinutes ?? 120)
  return { id: 'preview', repoId: draft?.repoId ?? '0', fullName: repository?.fullName ?? draft?.fullName ?? null, state: 'upcoming', scheduledAt: at,
    windowEndsAt: new Date(Date.parse(at) + windowMinutes * 60_000).toISOString(), windowMinutes, launcherWallet: plan?.launcherWallet || '11111111111111111111111111111111',
    maxInitialBuyLamports: preflight.plannedBuyLamports ?? '0', note: plan?.note || null, announcedBy: draft?.adminLogin ?? 'you', announcedAt: new Date().toISOString() }
}

function PreviewStep({ preflight, plan, draft, repository, busy, state, signInHref, onContinue }) {
  const schedule = previewSchedule({ preflight, plan, draft, repository })
  const repo = { fullName: schedule.fullName ?? `Repository ${schedule.repoId}` }
  return <div className="guide-body">
    <p className="transparency-lede">This is what everyone will see once you publish: the repository&apos;s launch page and its entry on the launch calendar, feeds and webhooks. Nothing is public yet.</p>
    <span className="guide-preview-label">Preview · /launch/{schedule.repoId}</span>
    {/* Inert: a picture of the public page. Its links and headings belong to the published page, not to this step. */}
    <div className="guide-preview" inert><ScheduledLaunchBlocked repo={repo} schedule={schedule}/></div>
    <span className="guide-preview-label">Preview · /launches</span>
    <div className="guide-preview" inert><ul className="launches-list"><li className="launches-row"><div className="launches-when"><strong>{utc(schedule.scheduledAt)}</strong><small>Window {schedule.windowMinutes} min</small></div>
        <div className="launches-what"><strong>{repo.fullName}</strong><p>Launching wallet <code>{short(schedule.launcherWallet)}</code> · {BigInt(schedule.maxInitialBuyLamports) > 0n ? `initial buy at most ${sol(schedule.maxInitialBuyLamports)}` : 'no initial buy'} · announced by GitHub admin {schedule.announcedBy}</p>
          {schedule.note && <p>“{schedule.note}”</p>}<div className="launches-tags"><span className="launches-tag">Upcoming</span></div></div></li></ul></div>
    <ErrorCard state={state} onSignIn={signInHref}/>
    <div className="guide-actions"><button type="button" className="button primary" onClick={onContinue} disabled={busy}>{busy ? 'Saving…' : 'Continue to publish'}</button></div>
  </div>
}

function PublishStep({ preflight, plan, draft, published, state, signInHref, onPublish, onAction }) {
  if (draft?.status === 'published') {
    const scheduleId = published?.id ?? draft.scheduleId
    return <div className="guide-body guide-done" role="status">
      <p><strong>Published.</strong> {draft.fullName ?? 'Your repository'}&apos;s launch is on the public calendar{published ? ` for ${utc(published.scheduledAt)}` : ''}. Nobody can launch it before then; during the window only your wallet can.</p>
      <ul className="guide-next"><li><Link href={`/launches#schedule-${scheduleId}`}>Public listing</Link></li><li><Link href={`/launch/${draft.repoId}`}>Launch page</Link>: open it from the launching wallet when the window opens.</li>
        <li><a href={`/launches.ics?repos=${draft.repoId}`}>Add to your calendar</a></li><li><Link href="/launches/manage">Cancel or manage the schedule</Link></li></ul>
    </div>
  }
  if (!preflight || !plan) return <p role="status">Loading your plan…</p>
  const missing = preflight.requirements.filter(item => item.requiredFor.includes('schedule') && !['met', 'warn'].includes(item.status))
  return <div className="guide-body">
    <dl className="transparency-facts"><div><dt>Launch time</dt><dd>{utc(plan.scheduledAt)}</dd></div><div><dt>Window</dt><dd>{plan.windowMinutes} minutes</dd></div>
      <div><dt>Launching wallet</dt><dd><code title={plan.launcherWallet}>{short(plan.launcherWallet)}</code></dd></div>
      <div><dt>Initial buy</dt><dd>{BigInt(preflight.plannedBuyLamports ?? '0') > 0n ? `At most ${sol(preflight.plannedBuyLamports)}` : 'None'}</dd></div>
      <div><dt>Pre-launch quality</dt><dd>{preflight.quality.score === null ? 'Not enough evidence' : `${preflight.quality.score}/100`} <small>({preflight.quality.coveragePercent}% known)</small></dd></div></dl>
    {missing.length > 0 && <div className="state-card error guide-error" role="alert"><p>Before publishing:</p><ul>{missing.map(item => <li key={item.id}><strong>{item.label}:</strong> {item.detail}
      {item.remediation?.action && <> <button type="button" className="guide-link-button" onClick={() => onAction(item.remediation.action)}>{item.remediation.action === 'retry' ? 'Check again' : 'Edit the plan'}</button></>}</li>)}</ul></div>}
    <ErrorCard state={state} onSignIn={signInHref}/>
    <p className="guide-note">Publishing checks your GitHub admin access again, then announces the launch at once on the calendar, feeds and webhooks. You can cancel it before it launches; the cancellation is public too.</p>
    <div className="guide-actions"><button type="button" className="button primary" onClick={onPublish} disabled={state.busy || missing.length > 0 || !plan.acknowledged}>{state.busy ? 'Publishing…' : 'Publish schedule'}</button></div>
  </div>
}
