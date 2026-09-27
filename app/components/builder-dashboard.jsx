'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, RefreshCw, Search } from 'lucide-react'
import { BuilderReminders } from './builder-reminders'
import { GithubMark } from './github-mark'
import { CopyAddress } from './copy-address'
import { useWallet } from './wallet'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { formatUnits, formatSolDisplay } from '../lib/format.mjs'
import { claimBuilderQueue } from '../../src/builder-queue.mjs'

export function BuilderDashboard({ signedIn, githubLogin, errorCode }) {
  const { wallet, connect, provider } = useWallet()
  const [data,setData] = useState(null), [loading,setLoading] = useState(signedIn)
  const [error,setError] = useState(errorCode ? 'GitHub connection could not finish. Please try again.' : '')
  const [results,setResults] = useState({}), [busy,setBusy] = useState(false), [stage,setStage] = useState('')
  const [search,setSearch] = useState(''), [now,setNow] = useState(Date.now())
  const [needsLogin,setNeedsLogin] = useState(!signedIn)
  const actionLock = useRef(false)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/builders',{cache:'no-store'})
      const body = await response.json()
      if (response.status === 401) setNeedsLogin(true)
      if (!response.ok) throw new Error(body.error)
      setNeedsLogin(false); setData(body); setNow(Date.now())
    } catch (cause) { setData(null); setError(cause.message || 'Could not load your repositories. Try again.') }
    finally { setLoading(false) }
  },[])
  useEffect(() => { if (signedIn) void load() },[signedIn,load])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()),15000); return () => clearInterval(timer) },[])
  useEffect(() => {
    if (!busy) return
    const warn = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload',warn)
    return () => window.removeEventListener('beforeunload',warn)
  },[busy])

  const repos = data?.repositories ?? []
  const actionable = repo => repo.review && repo.expiresAt > now && !results[repo.repoId]
  const ready = repos.filter(actionable)
  const unbound = repos.filter(repo => !repo.wallet).slice(0,100)
  const sum = (items,key) => items.reduce((total,item) => total+BigInt(item[key] ?? '0'),0n).toString()
  const visible = repos.filter(repo => repo.fullName.toLowerCase().includes(search.trim().toLowerCase()))
  const settled = Object.values(results).filter(result => result.status === 'settled')
  const incomplete = Object.values(results).filter(result => !['settled','pending'].includes(result.status)).length

  async function claim(items) {
    if (actionLock.current || !items.length) return
    actionLock.current = true; setBusy(true); setError(''); setStage(`Claiming fees from ${items.length} ${items.length === 1 ? 'repository' : 'repositories'}…`)
    const initial = Object.fromEntries(items.map(repo => [repo.repoId,{status:'queued'}]))
    setResults(current => ({...current,...initial}))
    await claimBuilderQueue(items, async item => {
      const response = await fetch('/api/builders/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({review:item.review})})
      const result = await response.json()
      if (!['settled','pending','already-settled','failed'].includes(result.status)) throw new Error('Confirmation unavailable')
      return result
    }, (id,result) => setResults(current => ({...current,[id]:result})))
    setStage('Claim run complete. Results are shown below.'); setBusy(false); actionLock.current = false
    // Refresh amounts and eligibility; keep this run's receipts visible.
    await load()
  }
  async function setup() {
    if (actionLock.current) return
    actionLock.current = true; setBusy(true); setError('')
    try {
      const address = wallet || await connect()
      setStage('Checking GitHub access for your repositories…')
      const post = async body => {
        const response = await fetch('/api/builders/bind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
        const result = await response.json()
        if (!response.ok) throw new Error(result.error)
        return result
      }
      const challenge = await post({action:'challenge',repoIds:unbound.map(repo=>repo.repoId),wallet:address})
      setStage('Approve one message in your wallet to set these payout wallets. No SOL is spent.')
      const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(challenge.message)))
      setStage('Saving your payout wallets…')
      const result = await post({action:'bind',nonces:challenge.nonces,wallet:address,signature:btoa(String.fromCharCode(...signature))})
      setStage(`Payout wallet set for ${result.count} ${result.count===1?'repository':'repositories'}. You can now claim ready fees.`)
      await load()
    } catch(cause) { setError(cause.message || 'Wallet setup was not completed.'); setStage('') }
    finally { setBusy(false); actionLock.current = false }
  }
  async function refresh() { setResults({}); setStage(''); await load() }

  return <div className="builder-dashboard">
    {error && <div className="state-card error" role="alert">{error}{signedIn && !needsLogin && <button className="button outline" disabled={busy||loading} onClick={refresh}>Try again</button>}</div>}
    {needsLogin ? <div className="builder-connect inner-card"><GithubMark size={32}/><h2>Connect GitHub to collect your earnings</h2><p>See all tokenized repositories you administer, then claim their ready fees together.</p><a className="button primary" href="/api/github/start?mode=builders"><GithubMark size={18}/>Connect GitHub</a><small>Read-only metadata access. repo.ing cannot change your code.</small></div> : <>
      <div className="builder-account"><span><GithubMark size={17}/>{data?.githubLogin || githubLogin}</span><div><a href="https://github.com/apps/repo-ing/installations/new" target="_blank" rel="noreferrer">Manage GitHub access ↗</a><a href="/api/github/start?mode=builders">Reconnect</a><button className="button outline" onClick={refresh} disabled={busy||loading}><RefreshCw size={14} aria-hidden="true"/>{loading?'Checking…':'Refresh'}</button></div></div>
      {loading && !data && <div className="builder-empty" role="status"><span className="claim-spinner" aria-hidden="true"/>Checking your repositories and available fees…</div>}
      {data && <>
        <div className="builder-totals"><div><span>Available to claim</span><strong>{repos.some(repo=>repo.available===null)?'—':`${formatSolDisplay(sum(repos,'available'))} SOL`}</strong><small>{repos.some(repo=>repo.available===null)?'Some balances need another check.':'Current fees in your repository pools.'}</small></div><div><span>Total earned</span><strong>{formatSolDisplay(sum(repos,'earned'))} SOL</strong><small>Includes fees already paid.</small></div><div><span>Total paid</span><strong>{formatSolDisplay(sum(repos,'paid'))} SOL</strong><small>Completed repository payouts.</small></div></div>
        {!data.payoutReady && <p className="builder-notice" role="status">Payouts are paused while network funds are replenished. Your fees remain in their pools.</p>}
        {unbound.length > 0 && <div className="builder-setup inner-card"><div><h2>Set your payout wallet once</h2><p>Use the same wallet for {unbound.length} {unbound.length===1?'repository':'repositories'} without a saved payout wallet.</p>{wallet && <CopyAddress address={wallet} compact label="payout wallet"/>}<small>One wallet message. Existing payout wallets stay as they are.</small></div><button className="button outline" disabled={busy||loading} onClick={setup}>Set wallet for {unbound.length}</button></div>}
        <div className="builder-claim-bar"><div><strong>{formatUnits(sum(ready,'available'))} SOL ready</strong><p>Sent to each repository’s saved wallet shown below.</p></div><button className="button primary" disabled={busy||loading||!ready.length} onClick={()=>claim(ready)}>{busy?'Processing…':`Claim all ready fees${ready.length?` (${ready.length})`:''}`}</button></div>
        {stage && <div className="builder-run-status" role="status" aria-live="polite">{busy?<span className="claim-spinner" aria-hidden="true"/>:<Check size={18}/>}<div><strong>{stage}</strong>{busy&&<small>Keep this page open while queued claims are submitted. Each payout has its own receipt.</small>}{!busy&&Object.keys(results).length>0&&<small>{settled.length} {settled.length===1?'repository paid':'repositories paid'} · {formatUnits(sum(settled,'amount'))} SOL.{incomplete>0?' Some repositories need attention; see their rows and refresh to review again.':''}</small>}</div></div>}
        <section className="builder-repositories" aria-labelledby="builder-repos-title"><div className="builder-list-heading"><h2 id="builder-repos-title">Your repositories <span>{repos.length}</span></h2>{repos.length>5&&<label className="builder-search"><Search size={16}/><input type="search" placeholder="Find a repository…" aria-label="Find a repository" value={search} onChange={event=>setSearch(event.target.value)}/></label>}</div>
          {!repos.length?<div className="builder-empty"><h3>No tokenized repositories found</h3><p>Add your repositories to repo.ing’s read-only GitHub App access, then refresh. You must have admin access to claim.</p><Link href="/launch" className="button outline">Launch a repository</Link></div>:!visible.length?<p className="builder-empty">No repositories match your search.</p>:<div className="builder-repo-list">{visible.map(repo=>{
            const result=results[repo.repoId]
            const receipt=result?.signature||repo.pendingSignature
            const state=result?.status==='settled'?'Paid':result?.status==='already-settled'?'Already paid':result?.status==='pending'||repo.pendingSignature?'Checking payout':result?.status==='queued'?'Queued':result?.status==='unknown'?'Check confirmation':result?.status==='failed'?'Needs attention':!repo.wallet?'Set payout wallet':repo.available===null?'Balance unavailable':repo.available==='0'?'Up to date':repo.expiresAt<=now?'Refresh review':!repo.review?'Payouts paused':'Ready to claim'
            return <article className="builder-repo-row" key={repo.repoId}><div className="builder-repo-name"><Link href={`/token/${repo.mint}`}>{repo.fullName}</Link><span className={`builder-row-state ${result?.status==='settled'?'paid':''}`}>{state}</span>{result?.error&&<small>{result.error}</small>}</div>
              <div className="builder-repo-balance"><span>Available</span><strong>{repo.available===null?'—':`${formatUnits(repo.available)} SOL`}</strong><small>{formatSolDisplay(repo.earned)} SOL earned · {formatSolDisplay(repo.paid)} SOL paid</small></div>
              <div className="builder-repo-wallet"><span>Payout wallet</span>{repo.wallet?<CopyAddress address={repo.wallet} compact label="payout wallet"/>:<span>Not set</span>}</div>
              <div className="builder-repo-actions">{receipt?<a className="button outline" target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${receipt}`}>Receipt ↗</a>:<button className="button outline" disabled={busy||loading||!actionable(repo)} onClick={()=>claim([repo])}>Claim</button>}<Link href={`/claim/${repo.repoId}`}>Manage</Link></div>
            </article>
          })}</div>}
        </section>
        <BuilderReminders/>
        <p className="builder-footnote">Only repositories you administer and have shared with the GitHub App appear here. For graduated pools, the payout includes SOL fees accrued before confirmation. Other new earnings stay available for your next claim.</p>
      </>}
    </>}
  </div>
}
