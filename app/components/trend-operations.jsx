'use client'
import { useEffect,useState } from 'react'
import Link from 'next/link'
import { TrendReasons,DiscovererTable,GrowthMarketList } from './growth-surfaces'

const date=value=>value?new Date(value).toLocaleString():'—'
export function TrendOperations(){
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[filter,setFilter]=useState('queue')
  async function load(){
    const response=await fetch('/api/operations/trends',{cache:'no-store'}),body=await response.json()
    if(!response.ok)throw Error(body.error);setData(body)
  }
  useEffect(()=>{load().catch(e=>setError(e.message))},[])
  async function action(key,body){
    setBusy(key);setError('')
    try{const response=await fetch('/api/operations/trends',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      const result=await response.json();if(!response.ok)throw Error(result.error);await load()
    }catch(e){setError(e.message)}finally{setBusy('')}
  }
  const rows=data?.candidates.filter(c=>filter==='all'||!['active','launched','duplicate','rejected'].includes(c.state))??[]
  return <>
    <div className="growth-heading"><p>Review the source evidence, approve a repository, then launch with your wallet.</p><button className="button outline" disabled={!!busy} onClick={async()=>{setBusy('refresh');try{await load();setError('')}catch(e){setError(e.message)}finally{setBusy('')}}}>{busy==='refresh'?'Refreshing…':'Refresh'}</button></div>
    {error&&<p className="subtle-notice" role="alert">{error}</p>}
    {!data&&<p role="status">Loading trend evidence…</p>}
    {data&&<><details className="inner-card trend-source-status"><summary>Source status · checked {date(data.checkedAt)}</summary>{data.sources.map(s=><p key={s.source}><strong>{s.source.replaceAll('_',' ')}</strong> · {s.status} · {date(s.checkedAt)}{s.detail.error&&` · ${s.detail.error}`}</p>)}<p>GitHub velocity needs two observations at least one hour apart. Truncated activity results earn no activity points. Data expires after six hours.</p></details>
      <div className="discovery-tabs"><button aria-pressed={filter==='queue'} onClick={()=>setFilter('queue')}>Review queue</button><button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>All candidates</button></div>
      <div className="trend-candidate-list">{rows.map(c=><article className="inner-card trend-candidate" key={c.repoId}>
        <div className="growth-heading"><div><a href={`https://github.com/${c.fullName}`} target="_blank" rel="noreferrer"><strong>{c.fullName}</strong> ↗</a><p>{c.description}</p></div><span className="badge">{c.state}</span></div>
        <div className="trend-meta"><span>Score {c.score.total}/100</span><span>Repo indexed: {c.repoIndexed?'yes':'no'}</span><span>Market: {c.marketStatus??'none'}</span><span>Detected {date(c.detectedAt)}</span><span>Observed {date(c.observedAt)}</span></div>
        <TrendReasons candidate={c}/>
        <div className="trend-actions">{['detected','rejected','duplicate'].includes(c.state)&&<button className="button outline" disabled={!!busy||!!c.marketStatus&&c.marketStatus!=='failed'} onClick={()=>action(c.repoId,{action:'review',repoId:c.repoId,state:'reviewed',revision:c.revision})}>{busy===c.repoId?'Saving…':'Mark reviewed'}</button>}
          {c.state==='reviewed'&&<button className="button primary" disabled={!!busy} onClick={()=>action(c.repoId,{action:'review',repoId:c.repoId,state:'approved',revision:c.revision})}>{busy===c.repoId?'Verifying…':'Approve launch'}</button>}
          {c.ready&&<Link className="button primary" href={`/launch/${c.repoId}?from=trend`}>Review & launch</Link>}
          {c.state==='approved'&&<button className="button outline" disabled={!!busy} onClick={()=>action(c.repoId,{action:'review',repoId:c.repoId,state:'reviewed',revision:c.revision})}>Revoke approval</button>}
          {['detected','reviewed','approved'].includes(c.state)&&<button className="button outline" disabled={!!busy} onClick={()=>action(c.repoId,{action:'review',repoId:c.repoId,state:'rejected',revision:c.revision})}>Reject</button>}
          {c.mint&&c.indexedAt&&<Link href={`/token/${c.mint}`}>View market →</Link>}
          {c.reason&&<span className="muted">{c.reason.replaceAll('_',' ').toLowerCase()}</span>}
        </div></article>)}{!rows.length&&<p className="subtle-notice">No candidates in this view. The worker collects public signals every 30 minutes.</p>}</div>
      <details className="inner-card manual-trend"><summary>Add a curated CT / narrative signal</summary><form onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);action('manual',{action:'manual',...Object.fromEntries(form),occurredAt:new Date(form.get('occurredAt')).toISOString()})}}>
        <label>GitHub repository<input name="repositoryUrl" type="url" placeholder="https://github.com/owner/repo" required/></label>
        <label>Source link<input name="sourceUrl" type="url" placeholder="https://x.com/…/status/…" required/></label>
        <label>Source published at<input name="occurredAt" type="datetime-local" required/></label>
        <label>Why it matters<textarea name="note" minLength={5} maxLength={500} required/></label>
        <p>Keep it factual. Curated signals receive no numerical score points.</p><button className="button outline" disabled={!!busy}>{busy==='manual'?'Verifying repository…':'Add source'}</button>
      </form></details>
      <section className="growth-section"><h2>Recently launched from trends</h2><GrowthMarketList markets={data.recentTrends} kind="trend" empty="No approved trend has been launched yet."/></section>
      <section className="growth-section"><h2>Discoverer attribution</h2>{data.attributionReview.length>0&&<p role="alert">{data.attributionReview.length} market(s) need attribution review: {data.attributionReview.map(r=>`${r.repoId}: ${r.code}`).join(', ')}</p>}<DiscovererTable leaders={data.leaders}/></section>
    </>}
  </>
}
