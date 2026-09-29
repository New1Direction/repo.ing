'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatUnits } from '../lib/format.mjs'

const sol = value => value === undefined || value === null || value === '' ? '—' : `${formatUnits(value)} SOL`

function PhaseCell({ phase, label, repo, busy, onClaim }) {
  const data = repo[phase]
  if (!data?.enrolled) return <td>—</td>
  if (data.error) return <td><span className="inline-error" role="alert">{data.error}</span></td>
  const available = BigInt(data.available)
  return <td>
    <span>{sol(data.available)}</span>
    {available > 0n
      ? <button className="button outline" disabled={busy} onClick={() => onClaim(repo, phase.toUpperCase())}>Claim {label}</button>
      : data.latest?.status ? <small>Last claim {data.latest.status}</small> : <small>Nothing to claim</small>}
  </td>
}

export function PlatformFeeOperations() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const [signatureInput, setSignatureInput] = useState('')

  async function refresh() {
    try {
      const r = await fetch('/api/operations/platform-fees', { cache: 'no-store', signal: AbortSignal.timeout(120000) })
      const v = await r.json()
      if (!r.ok) throw Error(v.error)
      setData(v); setError('')
    } catch (e) { setError(e.message || 'Platform fee overview is unavailable.') }
  }
  useEffect(() => { void refresh() }, [])

  function note(message) { setLog(entries => [...entries.slice(-9), `${new Date().toLocaleTimeString()} · ${message}`]) }

  async function post(payload) {
    const r = await fetch('/api/operations/platform-fees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const v = await r.json().catch(() => ({}))
    if (!r.ok) throw Error(v.error || 'Request failed')
    return v.result
  }

  async function claim(repo, phase) {
    setBusy(true)
    try {
      const review = repo[phase.toLowerCase()]?.review
      if (!review) throw Error('Review expired — reload the list')
      const result = await post({ action: 'claim', review })
      note(`${repo.fullName} ${phase}: ${result?.status ?? 'submitted'} ${result?.signature ? `· ${result.signature.slice(0, 8)}…` : ''}`)
      await refresh()
    } catch (e) { note(`${repo.fullName} ${phase} FAILED: ${e.message}`) }
    finally { setBusy(false) }
  }

  async function claimAll() {
    setBusy(true)
    try {
      const targets = data.repos.flatMap(repo => ['dbc', 'damm']
        .filter(phase => repo[phase]?.review)
        .map(phase => ({ repo, phase: phase.toUpperCase() })))
      if (!targets.length) note('Nothing available to claim.')
      for (const { repo, phase } of targets) {
        try {
          const result = await post({ action: 'claim', review: repo[phase.toLowerCase()].review })
          note(`${repo.fullName} ${phase}: ${result?.status ?? 'submitted'}`)
        } catch (e) { note(`${repo.fullName} ${phase} FAILED: ${e.message}`) }
      }
      await refresh()
    } finally { setBusy(false) }
  }

  async function allocate() {
    setBusy(true)
    try {
      const result = await post({ action: 'allocate', review: data.revenue.reviews.allocate })
      note(`Allocated: ${JSON.stringify(result?.allocated ?? result)}`)
      await refresh()
    } catch (e) { note(`Allocate FAILED: ${e.message}`) }
    finally { setBusy(false) }
  }

  const claimable = data ? data.repos.reduce((sum, r) => sum + BigInt(r.dbc.available ?? 0n) + BigInt(r.damm.available ?? 0n), 0n) : null
  return <>
    <p className="muted">Uncollected 0.406% platform fees per repository, on both curve (DBC) and graduated (DAMM) pools. Claiming settles SOL to the fixed custody wallet; allocation applies the active 60/20/20 policy.</p>
    <div className="operations-toolbar">
      <span>{data ? `Checked ${new Date(data.checkedAt).toLocaleTimeString()}` : 'Inspecting pools…'}</span>
      <button className="button outline" onClick={refresh} disabled={busy || !data}>Refresh</button>
      {data && claimable > 0n && <button className="button primary" onClick={claimAll} disabled={busy}>Claim all ({sol(claimable.toString())})</button>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {data && <>
      <div className="operations-summary">
        <div className="inner-card"><span>Ready to allocate</span><strong>{sol(data.revenue.available)}</strong></div>
        <div className="inner-card"><span>Platform fees claimed</span><strong>{sol(data.revenue.claimed?.total)}</strong></div>
        <div className="inner-card"><span>Buyback reserve</span><strong>{sol(data.revenue.buybackReserve)}</strong></div>
        <div className="inner-card"><span>Policy</span><strong>{data.revenue.activePolicy ? `${data.revenue.activePolicy.buybackPermille / 10}/${data.revenue.activePolicy.liquidityPermille / 10}/${(1000 - data.revenue.activePolicy.buybackPermille - data.revenue.activePolicy.liquidityPermille) / 10}` : 'None'}</strong></div>
      </div>
      {data.revenue.reviews.allocate && <div className="builder-claim-bar">
        <div><strong>{sol(data.revenue.available)} SOL claimed but unallocated</strong><p>Allocate applies the active policy split into buyback, liquidity and treasury reserves.</p></div>
        <button className="button primary" onClick={allocate} disabled={busy}>Allocate now</button>
      </div>}
      <section className="inner-card operations-markets">
        <h2>Platform fees by repository</h2>
        <div className="operations-table-wrap"><table><thead><tr><th>Repository</th><th>DBC (curve)</th><th>DAMM (graduated)</th></tr></thead><tbody>
          {data.repos.map(repo => <tr key={repo.repoId}>
            <td><Link href={`/token/${repo.mint}`}>{repo.fullName}</Link><small>Repo {repo.repoId}</small></td>
            <PhaseCell phase="dbc" label="DBC" repo={repo} busy={busy} onClaim={claim}/>
            <PhaseCell phase="damm" label="DAMM" repo={repo} busy={busy} onClaim={claim}/>
          </tr>)}
        </tbody></table></div>
        {!data.repos.length && <p>No finalized markets.</p>}
      </section>
      <section className="inner-card">
        <h2>Record a manual buyback</h2>
        <p className="muted">Bought $REPOING from the custody wallet yourself? Paste the transaction signature. The server verifies the finalized receipt — custody SOL spent, canonical mint, treasury destination — before recording it as a settled buyback against the reserve.</p>
        <div className="operations-toolbar">
          <input className="text-input" style={{ flex: 1, minWidth: 240 }} placeholder="Transaction signature…" value={signatureInput}
            onChange={e => setSignatureInput(e.target.value)} aria-label="Buyback transaction signature"/>
          <button className="button outline" onClick={importBuyback} disabled={busy}>Verify & record</button>
        </div>
      </section>
      {log.length > 0 && <section className="inner-card"><h2>Activity</h2>{log.map((line, i) => <p key={i} className="muted">{line}</p>)}</section>}
    </>}
  </>

  async function importBuyback() {
    const signature = signatureInput.trim()
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) { note('Enter the full buyback transaction signature.'); return }
    setBusy(true)
    try {
      const rev = await (await fetch('/api/platform-revenue', { cache: 'no-store' })).json()
      if (!rev.reviews?.import) throw Error('Import review unavailable — reload the page.')
      const result = await (await fetch('/api/platform-revenue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'intent.import', signature, review: rev.reviews.import }) })).json()
      if (result.error) throw Error(result.error)
      note(`Imported buyback ${signature.slice(0, 12)}… · ${formatUnits(result.result.amount)} SOL`)
      await refresh()
    } catch (e) { note(`Import FAILED: ${e.message}`) }
    finally { setBusy(false) }
  }
}
