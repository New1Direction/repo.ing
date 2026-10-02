'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { GithubMark } from './github-mark'
import { MaintainerDecision } from './maintainer-decision'
import '../maintainer-opt-out.css'

const APP_ACCESS_URL = 'https://github.com/apps/repo-ing/installations/new'

// /opt-out: the signed-in maintainer's admin repositories (the builder dashboard's listing), each with its opt-out or decline.
export function MaintainerOptOut({ signedIn, githubLogin, errorCode }) {
  const [data, setData] = useState(null), [loading, setLoading] = useState(signedIn)
  const [error, setError] = useState(errorCode ? 'GitHub sign-in could not finish. Please try again.' : '')
  const [needsLogin, setNeedsLogin] = useState(!signedIn), [search, setSearch] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/opt-out', { cache: 'no-store', signal: AbortSignal.timeout(60_000) })
      const body = await response.json().catch(() => ({}))
      if (response.status === 401) { setNeedsLogin(true); setData(null); return }
      if (!response.ok) throw new Error(body.error)
      setNeedsLogin(false); setData(body)
    } catch (cause) { setData(null); setError(cause.name === 'TimeoutError' ? 'GitHub took too long to answer. Try again.' : cause.message || 'Could not load your repositories. Try again.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { if (signedIn) void load() }, [signedIn, load])

  if (needsLogin) return <section className="opt-out-signin inner-card" aria-labelledby="opt-out-signin-title">
    {error && <p className="inline-error" role="alert">{error}</p>}
    <h2 id="opt-out-signin-title">Sign in with GitHub</h2>
    <p>repo.ing lists the public repositories you administer that are shared with its read-only GitHub App. Signing in grants no access to your code.</p>
    <a className="button primary" href="/api/github/start?mode=opt-out"><GithubMark size={18}/>Sign in with GitHub</a>
    <small>Repository missing? Share it with the app under <a href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">GitHub access settings ↗</a>. You can remove the app after opting out; the opt-out stays.</small>
  </section>

  const repos = data?.repositories ?? []
  const query = search.trim().toLowerCase()
  const visible = repos.filter(repo => (repo.fullName ?? repo.repoId).toLowerCase().includes(query))
  return <section className="opt-out-repos" aria-labelledby="opt-out-repos-title" aria-busy={loading || undefined}>
    <div className="opt-out-account"><span><GithubMark size={17}/>{data?.githubLogin || githubLogin}</span>
      <div><a href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">Manage GitHub access ↗</a><a href="/api/github/start?mode=opt-out">Switch account</a>
        <button type="button" className="button outline" onClick={load} disabled={loading}><RefreshCw size={14} aria-hidden="true"/>{loading ? 'Checking…' : 'Refresh'}</button></div></div>
    {error && <div className="state-card error" role="alert">{error}</div>}
    {loading && !data && <div className="opt-out-empty" role="status"><span className="claim-spinner" aria-hidden="true"/>Checking your GitHub repositories…</div>}
    {data && <>
      <div className="opt-out-list-heading"><h2 id="opt-out-repos-title">Repositories you admin <span>{repos.length}</span></h2>
        {repos.length > 6 && <label className="opt-out-search"><Search size={16} aria-hidden="true"/><input type="search" placeholder="Find a repository…" aria-label="Find a repository" value={search} onChange={event => setSearch(event.target.value)}/></label>}</div>
      {!repos.length ? <div className="opt-out-empty"><h3>No repositories found</h3><p>repo.ing only sees public repositories you administer that are shared with its read-only GitHub App. Add them in <a href={APP_ACCESS_URL} target="_blank" rel="noopener noreferrer">GitHub access settings ↗</a>, then refresh.</p></div>
        : !visible.length ? <p className="opt-out-empty">No repositories match your search.</p>
          : <ul className="opt-out-list">{visible.map(repo => <li key={repo.repoId} className="opt-out-repo">
            <div className="opt-out-repo-name">{repo.fullName ? <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noopener noreferrer">{repo.fullName}</a> : <span>Repository {repo.repoId}</span>}
              <small>{repo.mint ? <>Has a market · <Link href={`/token/${repo.mint}`}>View it</Link></> : 'No market on repo.ing'}</small></div>
            <MaintainerDecision key={`${repo.mint ?? 'none'}:${repo.decision?.createdAt ?? 'none'}`} repoId={repo.repoId} fullName={repo.fullName ?? `repository ${repo.repoId}`}
              live={Boolean(repo.mint)} decision={repo.decision} compact/>
          </li>)}</ul>}
    </>}
  </section>
}
