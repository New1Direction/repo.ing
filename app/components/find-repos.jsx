'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Star, GitFork, X, ArrowUpRight } from 'lucide-react'
import { TrendReasons } from './growth-surfaces'
import { ACTIVITY_FILTERS, MARKET_FILTERS, SEARCH_EXAMPLES, QUERY_LIMIT, matchesSearchFilters, searchRepositoryUrl } from '../../src/repo-search.mjs'
import { TREND_FRESH_MS } from '../../src/trend-rules.mjs'

const number = value => Number(value).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })
export function FindRepos({ initial, smartSearch }) {
  const router = useRouter(), request = useRef(null), field = useRef(null), sequence = useRef(0)
  const [candidates, setCandidates] = useState(initial ?? [])
  const [query, setQuery] = useState(''), [result, setResult] = useState(null)
  const [market, setMarket] = useState('all'), [activity, setActivity] = useState('any')
  const [busy, setBusy] = useState(false), [error, setError] = useState(initial === null ? 'Repositories are temporarily unavailable. Try refreshing.' : '')
  const [now, setNow] = useState(Date.now())

  function cancel() { sequence.current++; request.current?.abort(); request.current = null; setBusy(false) }
  function clear() {
    cancel(); setQuery(''); setResult(null); setMarket('all'); setActivity('any'); setError('')
    window.history.replaceState(null, '', '/find-repos'); field.current?.focus()
  }
  async function search(value = query) {
    cancel()
    const text = value.trim()
    if (!text) { clear(); return }
    setQuery(text); setError(''); setBusy(true)
    const controller = new AbortController(), id = sequence.current
    request.current = controller
    const url = searchRepositoryUrl(text)
    try {
      const response = await fetch(url ? '/api/resolve' : '/api/repo-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(url ? { url } : { query: text }), signal: controller.signal,
      })
      const data = await response.json()
      if (!response.ok) throw Error(data.error || 'Search could not be completed. Try again.')
      if (id !== sequence.current) return
      if (url) { router.push(data.mint ? `/token/${data.mint}` : `/launch/${data.repoId}`); return }
      setResult(data); setCandidates(data.candidates); setMarket(data.filters.market); setActivity(data.filters.activity)
      window.history.replaceState(null, '', `/find-repos?q=${encodeURIComponent(text)}`)
    } catch (cause) {
      if (id === sequence.current && cause.name !== 'AbortError') setError(cause.message)
    } finally { if (id === sequence.current) { setBusy(false); request.current = null } }
  }
  useEffect(() => {
    const text = new URLSearchParams(window.location.search).get('q')
    if (text && text.length <= QUERY_LIMIT) search(text)
    return () => { sequence.current++; request.current?.abort() }
  }, [])
  useEffect(() => {
    let stopped = false, controller = null
    async function refresh() {
      if (document.visibilityState !== 'visible' || controller) return
      controller = new AbortController()
      try {
        const response = await fetch('/api/repo-search', { cache: 'no-store', signal: controller.signal })
        if (response.ok) { const data = await response.json(); if (!stopped) setCandidates(data.candidates) }
      } catch {} finally { controller = null }
    }
    const timer = setInterval(refresh, 60000), clock = setInterval(() => setNow(Date.now()), 10000)
    document.addEventListener('visibilitychange', refresh)
    return () => { stopped = true; clearInterval(timer); clearInterval(clock); controller?.abort(); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  // Rebind results to fresh evidence on every refresh; never retain a vanished
  // candidate or an obsolete launch action from a previous model response.
  const resultIds = result && new Set(result.ids)
  const pool = result ? candidates.filter(c => resultIds.has(c.repoId)) : candidates
  const fresh = pool.filter(c => now - Date.parse(c.observedAt) <= TREND_FRESH_MS)
  const visible = fresh.filter(c => matchesSearchFilters(c, market, activity, now))
  const filtered = result || market !== 'all' || activity !== 'any'
  return <div className="repo-finder">
    <form className="finder-search" role="search" onSubmit={event => { event.preventDefault(); search() }} aria-busy={busy}>
      <label htmlFor="find-repo-query" className="sr-only">Search repositories</label>
      <div className="finder-input"><Search size={19} aria-hidden="true"/><input id="find-repo-query" ref={field} value={query} maxLength={QUERY_LIMIT} autoComplete="off" type="search"
        aria-describedby="finder-help" placeholder={smartSearch ? 'Describe a project or paste a GitHub URL' : 'Search repositories or paste a GitHub URL'}
        onChange={event => { cancel(); setQuery(event.target.value); setError('') }}/></div>
      <button className="button primary" type="submit" disabled={busy || !query.trim()}>{busy ? <><span className="claim-spinner" aria-hidden="true"/> Searching…</> : 'Search'}</button>
    </form>
    <div className="finder-examples"><span>Try:</span>{SEARCH_EXAMPLES.map(text => <button key={text} type="button" onClick={() => search(text)}>{text}</button>)}</div>
    <p id="finder-help" className="finder-help">Search repositories tracked by repo.ing. {smartSearch ? 'Descriptions are matched with AI; trend scores come from public evidence. Search text is processed by TypeSafe.' : 'Search names and descriptions, or narrow the list with filters.'}</p>
    <div className="finder-toolbar">
      <div className="finder-tabs" role="group" aria-label="Market status">{Object.entries(MARKET_FILTERS).map(([value, label]) => <button type="button" key={value} disabled={busy} aria-pressed={market === value} onClick={() => setMarket(value)}>{label}</button>)}</div>
      <label className="finder-activity"><span className="sr-only">Repository activity</span><select value={activity} disabled={busy} onChange={event => setActivity(event.target.value)}>{Object.entries(ACTIVITY_FILTERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {filtered && <button type="button" className="finder-clear" onClick={clear}><X size={14} aria-hidden="true"/> Clear</button>}
    </div>
    <div className="finder-summary" role="status" aria-live="polite">{busy ? 'Finding matching repositories…' : <>{visible.length} {visible.length === 1 ? 'repository' : 'repositories'}{result ? <> for “{result.query}”</> : ' gaining attention'} · {market !== 'all' ? `${MARKET_FILTERS[market]} · ` : ''}{activity !== 'any' ? `${ACTIVITY_FILTERS[activity]} · ` : ''}Sorted by trend evidence</>}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {result?.notice && <p className="finder-help">{result.notice}</p>}
    <div className="inner-card growth-trending finder-results" aria-busy={busy}>
      {visible.map(c => <article key={c.repoId}>
        <div className="growth-heading"><div className="finder-repository"><a href={`https://github.com/${c.fullName}`} target="_blank" rel="noreferrer"><strong>{c.fullName}</strong><ArrowUpRight size={15} aria-hidden="true"/></a><p>{c.description}</p></div>
          {c.mint ? <Link className="button outline" href={`/token/${c.mint}`}>View market</Link> : c.ready ? <Link className="button outline" href={`/launch/${c.repoId}?from=trend`}>Review & launch</Link> : <a className="button outline" href={`https://github.com/${c.fullName}`} target="_blank" rel="noreferrer">View repository ↗</a>}
        </div>
        <div className="finder-meta">{c.stars !== null && <span title={`${c.stars} GitHub stars`}><Star size={14} aria-hidden="true"/>{number(c.stars)}</span>}{c.forks !== null && <span title={`${c.forks} GitHub forks`}><GitFork size={14} aria-hidden="true"/>{number(c.forks)}</span>}
          <span className="finder-market-state">{c.marketState === 'live' ? 'Market live' : c.marketState === 'pending' ? 'Launch in progress' : 'No market yet'}</span>
          {c.score.inputs.stars?.delta > 0 && <span>+{c.score.inputs.stars.delta} stars / {c.score.inputs.stars.hours.toFixed(1)}h</span>}
          <span>Checked {Math.max(0, Math.floor((now - Date.parse(c.observedAt))/60000))}m ago</span>
        </div><TrendReasons candidate={c}/>
      </article>)}
      {!visible.length && <div className="finder-empty"><Search size={24} aria-hidden="true"/><h2>{filtered ? 'No matching repositories yet.' : 'New repositories are being checked.'}</h2><p>{filtered ? 'Try a broader topic or clear a filter. This searches our tracked repos, not all of GitHub.' : 'Fresh candidates appear as public attention is verified.'}</p><div>{filtered && <button type="button" className="button outline" onClick={clear}>Show all repos</button>}<Link className="button outline" href="/launch">Have a repo? Launch it</Link></div></div>}
    </div>
    <p className="growth-footnote">Discover a repo early. Eligible launchers earn a share of curve fees for up to 30 days, capped at 2.5 SOL. <Link href="/discoverers">See discoverers →</Link></p>
  </div>
}
