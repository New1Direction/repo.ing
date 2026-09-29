'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Copy, ExternalLink } from 'lucide-react'
import { formatSolDisplay } from '../lib/format.mjs'

const sol = value => value === null || value === undefined ? '—' : `${formatSolDisplay(value)} SOL`

function Candidate({ item, busy, onRecord }) {
  const [message, setMessage] = useState('')
  async function copy() {
    try { await navigator.clipboard.writeText(`${item.title}\n\n${item.body}`); setMessage('Copied') }
    catch { setMessage('Select the text below and copy it.') }
  }
  return <article className="invite-candidate">
    <header><div><a href={`https://github.com/${item.fullName}`} target="_blank" rel="noreferrer"><strong>{item.fullName}</strong></a>
      <small>★ {item.stars.toLocaleString('en-US')} · Repo {item.repoId} · <Link href={`/claim/${item.repoId}`}>Claim page</Link></small></div>
      <div className="invite-amount"><span>Unclaimed</span><strong>{sol(item.available)}</strong></div></header>
    <details><summary>Invite text</summary><textarea readOnly value={`${item.title}\n\n${item.body}`} onFocus={event => event.target.select()} aria-label={`Invite text for ${item.fullName}`}/></details>
    <div className="invite-actions">
      {item.issueUrl ? <a className="button primary" href={item.issueUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14}/>Open GitHub issue</a>
        : <span className="badge warn">{item.hasIssues === false ? 'Issues disabled' : 'Issue status unknown'}</span>}
      <button className="button outline" type="button" onClick={copy}><Copy size={14}/>Copy text</button>
      <button className="button outline" type="button" disabled={busy} onClick={() => onRecord(item, 'invited')}>Mark invited</button>
      <button className="button outline" type="button" disabled={busy} onClick={() => onRecord(item, 'dismissed')}>Dismiss</button>
      {message && <small role="status">{message}</small>}
    </div>
  </article>
}

export function MaintainerInvites() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function refresh() {
    setError('')
    try {
      const r = await fetch('/api/operations/invites', { cache: 'no-store', signal: AbortSignal.timeout(120000) })
      const v = await r.json()
      if (!r.ok) throw Error(v.error)
      setData(v)
    } catch (e) { setError(e.message || 'Invite candidates are unavailable.') }
  }
  useEffect(() => { void refresh() }, [])
  async function record(item, action) {
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/operations/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoId: item.repoId, action }) })
      const v = await r.json().catch(() => ({}))
      if (!r.ok) throw Error(v.error || 'Request failed')
      setData(current => ({ ...current, candidates: current.candidates.filter(c => c.repoId !== item.repoId) }))
    } catch (e) { setError(`${item.fullName}: ${e.message}`) }
    finally { setBusy(false) }
  }
  return <section className="inner-card operations-markets maintainer-invites" aria-labelledby="invites-heading">
    <h2 id="invites-heading">Invite candidates</h2>
    <p className="muted">Markets with no claimed builder and at least {data ? sol(data.threshold) : '…'} in verified unclaimed fees, largest first. At most 10 are shown. Nothing is posted automatically: “Open GitHub issue” only opens a prefilled draft. “Mark invited” hides a repository for 30 days; “Dismiss” hides it permanently.</p>
    <div className="operations-toolbar"><span>{data ? `Checked ${new Date(data.checkedAt).toLocaleTimeString()}` : 'Verifying fees…'}</span><button className="button outline" onClick={refresh} disabled={busy || !data}>Refresh</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {data && (data.candidates.length ? data.candidates.map(item => <Candidate key={item.repoId} item={item} busy={busy} onRecord={record}/>) : <p>No repositories need an invite right now.</p>)}
  </section>
}
