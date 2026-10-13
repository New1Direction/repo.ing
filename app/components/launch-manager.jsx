'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { GithubMark } from './github-mark'
import { useWallet } from './wallet'
import '../maintainer-opt-out.css'

const APP_ACCESS_URL = 'https://github.com/apps/repo-ing/installations/new'
const KINDS = [['launch.scheduled', 'Launch scheduled'], ['launch.schedule_cancelled', 'Schedule cancelled'], ['launch.window_open', 'Launch window open'],
  ['launch.schedule_lapsed', 'Window passed without a launch'], ['market.launched', 'Market launched'], ['market.graduated', 'Market graduated'],
  ['group_launch.raising', 'Group launch raising'], ['group_launch.launched', 'Group launch launched'], ['group_launch.failed', 'Group launch failed']]
const post = async (url, body) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'This could not be saved. Try again.')
  return result
}
// datetime-local value (local time) one hour and five minutes from now, rounded to the minute.
const earliestLocal = () => { const date = new Date(Date.now() + 65 * 60_000); date.setSeconds(0, 0); return new Date(date - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }

// /launches/manage: scheduled launches for repositories the signed-in GitHub user administers, and their launch feed webhooks.
export function LaunchManager({ signedIn, githubLogin, errorCode, schedulingEnabled, webhooks, rules }) {
  const [data, setData] = useState(null), [loading, setLoading] = useState(signedIn), [needsLogin, setNeedsLogin] = useState(!signedIn)
  const [error, setError] = useState(errorCode ? 'GitHub sign-in could not finish. Please try again.' : '')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/launch-schedules', { cache: 'no-store', signal: AbortSignal.timeout(60_000) })
      const body = await response.json().catch(() => ({}))
      if (response.status === 401) { setNeedsLogin(true); setData(null); return }
      if (!response.ok) throw new Error(body.error)
      setNeedsLogin(false); setData(body)
    } catch (cause) { setData(null); setError(cause.name === 'TimeoutError' ? 'GitHub took too long to answer. Try again.' : cause.message || 'Could not load your repositories.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { if (signedIn) void load() }, [signedIn, load])
  if (needsLogin) return <section className="inner-card launch-manage" aria-labelledby="launch-signin-title">
    {error && <p className="inline-error" role="alert">{error}</p>}
    <h2 id="launch-signin-title">Sign in with GitHub</h2>
    <p className="launch-manage-note">Read-only: it tells repo.ing who you are and which public repositories you administer. It grants no access to your code.</p>
    <a className="button primary" href="/api/github/start?mode=launches"><GithubMark size={18}/>Sign in with GitHub</a>
  </section>
  const repos = data?.repositories ?? []
  return <div className="launch-manage">
    <div className="opt-out-account"><span><GithubMark size={17}/>{data?.githubLogin || githubLogin}</span>
      <div><a href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">Manage GitHub access ↗</a>
        <button type="button" className="button outline" onClick={load} disabled={loading}><RefreshCw size={14} aria-hidden="true"/>{loading ? 'Checking…' : 'Refresh'}</button></div></div>
    {error && <div className="state-card error" role="alert">{error}</div>}
    {loading && !data && <p role="status" className="launch-manage-note">Checking your GitHub repositories…</p>}
    {data && <section className="launches-list" aria-label="Repositories you administer">
      {!repos.length ? <p className="launches-empty">No public repositories you administer are shared with repo.ing&apos;s read-only GitHub App. Add them in <a href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">GitHub access settings ↗</a>, then refresh.</p>
        : repos.map(repo => <RepoSchedule key={`${repo.repoId}:${repo.schedule?.id ?? 'none'}`} repo={repo} enabled={schedulingEnabled && data.schedulingEnabled} rules={rules} onChange={load}/>)}
    </section>}
    {webhooks && <Webhooks/>}
  </div>
}

function RepoSchedule({ repo, enabled, rules, onChange }) {
  // The connected wallet, if any, is a starting suggestion for the launching wallet.
  const { wallet } = useWallet() ?? {}
  const [form, setForm] = useState({ scheduledAt: earliestLocal(), windowMinutes: String(rules.defaultWindowMinutes), launcherWallet: typeof wallet === 'string' ? wallet : '', maxInitialBuySol: '0', note: '' })
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const name = repo.fullName ?? `Repository ${repo.repoId}`
  const submit = async event => {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const lamports = BigInt(Math.round(Number(form.maxInitialBuySol || '0') * 1e9)).toString()
      await post('/api/launch-schedules', { action: 'schedule', repoId: repo.repoId, scheduledAt: new Date(form.scheduledAt).toISOString(),
        windowMinutes: Number(form.windowMinutes), launcherWallet: form.launcherWallet.trim(), maxInitialBuyLamports: lamports, note: form.note })
      await onChange()
    } catch (cause) { setMessage(cause.message) } finally { setBusy(false) }
  }
  const cancel = async () => {
    setBusy(true); setMessage('')
    try { await post('/api/launch-schedules', { action: 'cancel', repoId: repo.repoId }); await onChange() }
    catch (cause) { setMessage(cause.message) } finally { setBusy(false) }
  }
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }))
  return <article className="launch-manage-repo">
    <header><strong>{repo.fullName ? <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer">{name}</a> : name}</strong>
      <small>{repo.mint ? <>Has a market · <Link href={`/token/${repo.mint}#transparency`}>Launch quality</Link></> : repo.launchInProgress ? 'A launch is in progress' : repo.optedOut ? 'Opted out of repo.ing' : repo.schedule ? `Scheduled · ${repo.schedule.state}` : 'No market yet'}</small></header>
    {repo.schedule ? <><p className="launch-manage-note">Launches {new Date(repo.schedule.scheduledAt).toLocaleString()} from <code>{repo.schedule.launcherWallet}</code> with at most {Number(repo.schedule.maxInitialBuyLamports) / 1e9} SOL, window {repo.schedule.windowMinutes} minutes. <Link href={`/launches#schedule-${repo.schedule.id}`}>Public listing</Link></p>
      <div><button type="button" className="button outline" onClick={cancel} disabled={busy}>{busy ? 'Cancelling…' : 'Cancel schedule'}</button></div></>
      : !repo.mint && !repo.launchInProgress && !repo.optedOut && (enabled ? <form className="launch-manage-form" onSubmit={submit}>
        <label>Launch time (your time zone)<input type="datetime-local" required value={form.scheduledAt} onChange={set('scheduledAt')}/></label>
        <label>Window (minutes)<input type="number" min={rules.minWindowMinutes} max={rules.maxWindowMinutes} step="1" required value={form.windowMinutes} onChange={set('windowMinutes')}/></label>
        <label>Most the launch buys (SOL)<input type="number" min="0" max="1" step="0.001" required value={form.maxInitialBuySol} onChange={set('maxInitialBuySol')}/></label>
        <label className="wide">Wallet that signs the launch<input required spellCheck={false} autoComplete="off" placeholder="Solana address" value={form.launcherWallet} onChange={set('launcherWallet')}/></label>
        <label className="wide">Public note (optional, 280 characters, links only to github.com)<textarea maxLength={280} value={form.note} onChange={set('note')}/></label>
        <p className="launch-manage-note wide">At least {rules.minNoticeMinutes} minutes and at most {rules.maxAheadDays} days ahead. Publishing is immediate and public.</p>
        <div><button type="submit" className="button primary" disabled={busy}>{busy ? 'Publishing…' : 'Publish schedule'}</button></div>
      </form> : <p className="launch-manage-note">Scheduling new launches is paused.</p>)}
    {message && <p className="inline-error" role="alert">{message}</p>}
  </article>
}

function Webhooks() {
  const [hooks, setHooks] = useState(null), [url, setUrl] = useState(''), [kinds, setKinds] = useState(KINDS.map(([kind]) => kind)), [repos, setRepos] = useState('')
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const response = await fetch('/api/launch-webhooks', { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (response.ok) setHooks(body.webhooks); else setMessage(body.error || 'Webhooks are unavailable.')
  }, [])
  useEffect(() => { void load() }, [load])
  const create = async event => {
    event.preventDefault(); setBusy(true); setMessage('')
    try { await post('/api/launch-webhooks', { action: 'create', url, kinds, repoIds: repos.split(',').map(value => value.trim()).filter(Boolean) }); setUrl(''); await load() }
    catch (cause) { setMessage(cause.message) } finally { setBusy(false) }
  }
  const remove = async id => { setBusy(true); try { await post('/api/launch-webhooks', { action: 'delete', id }); await load() } catch (cause) { setMessage(cause.message) } finally { setBusy(false) } }
  return <section id="webhooks" className="inner-card" aria-labelledby="webhooks-title">
    <h2 id="webhooks-title">Launch feed webhooks</h2>
    <p className="launch-manage-note">repo.ing POSTs each new feed event as JSON to your HTTPS URL, signed with Ed25519 (<a href="/api/v1/webhooks/signing-key">public key</a>). Failed deliveries are retried for about nine hours; a URL that keeps failing is paused. Up to five webhooks.</p>
    <ul className="launch-manage-hooks">{(hooks ?? []).map(hook => <li key={hook.id}><code>{hook.url}</code><span>{hook.status}{hook.consecutiveFailures ? ` · ${hook.consecutiveFailures} failures` : ''}</span>
      <button type="button" className="button outline" onClick={() => remove(hook.id)} disabled={busy}>Delete</button></li>)}</ul>
    <form className="launch-manage-form" onSubmit={create}>
      <label className="wide">HTTPS URL<input type="url" required placeholder="https://example.com/repoing" value={url} onChange={event => setUrl(event.target.value)}/></label>
      <label className="wide">Only these GitHub repository ids (optional, comma-separated)<input value={repos} onChange={event => setRepos(event.target.value)}/></label>
      <fieldset className="wide"><legend className="launch-manage-note">Events</legend>{KINDS.map(([kind, label]) => <label key={kind}>
        <input type="checkbox" checked={kinds.includes(kind)} onChange={event => setKinds(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))}/>{label}</label>)}</fieldset>
      <div><button type="submit" className="button primary" disabled={busy || !kinds.length}>Add webhook</button></div>
    </form>
    {message && <p className="inline-error" role="alert">{message}</p>}
  </section>
}
