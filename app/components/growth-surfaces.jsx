'use client'
import Link from 'next/link'
import { useEffect,useState } from 'react'
import { CopyAddress } from './copy-address'
import { WalletIdentity } from './wallet-identity'
import { formatSolRounded } from '../lib/format.mjs'

const sol=value=>value===null?'Being verified':`${formatSolRounded(value)} SOL`
// Server and browser must render the same text (React hydration): dates in UTC, and anything that depends on the current
// time only after mount (null until then, so both first renders agree).
const utcDate=at=>new Date(at).toLocaleDateString('en-US',{timeZone:'UTC'})
const utcDateTime=at=>`${new Date(at).toLocaleString('en-US',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} UTC`
function useNow(interval=10000){
  const [now,setNow]=useState(null)
  useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),interval);return()=>clearInterval(timer)},[interval])
  return now
}
const stillValid=(until,now)=>now===null||Date.parse(until)>now
const names={stars:'Star velocity',starAcceleration:'Star acceleration',forks:'Fork velocity',contributors:'Contributor acceleration',activity:'Commit acceleration',release:'Recent release',mentions:'HN stories',trending:'GitHub Trending'}
export function TrendReasons({candidate}){
  const {score}=candidate
  const now=useNow()
  return <details className="trend-reasons"><summary>Why this repository? · {score.total}/100</summary>
    <dl>{Object.entries(score.parts).map(([key,value])=><div key={key}><dt>{names[key]}</dt><dd>{value} points</dd></div>)}</dl>
    {['stars','forks'].map(key=><p key={key}>{key==='stars'?'Stars':'Forks'}: {score.inputs[key]?`${score.inputs[key].delta>=0?'+':''}${score.inputs[key].delta} over ${score.inputs[key].hours.toFixed(1)} hours (${score.inputs[key].perDay.toFixed(1)}/day)`:'Collecting baseline; no velocity score yet.'}</p>)}
    <p>Release: {score.inputs.releaseAt?utcDate(score.inputs.releaseAt):'none observed'} · HN stories: {score.inputs.mentions}</p>
    {score.inputs.activity?.complete?<p>Last 24h / previous 24h: {score.inputs.activity.currentCommits} / {score.inputs.activity.previousCommits} commits · {score.inputs.activity.currentContributors} / {score.inputs.activity.previousContributors} identified contributors.</p>:<p>Commit window unavailable or truncated; no activity points.</p>}
    <ul>{candidate.signals.map((s,i)=><li key={`${s.source}-${i}`}><a href={s.url} target="_blank" rel="noreferrer">{s.source.replaceAll('_',' ')} ↗</a> · {s.note}{now!==null&&Date.parse(s.expiresAt)<=now?' (expired)':''}</li>)}</ul>
    {candidate.latestObservation&&<p><a href={candidate.latestObservation.sources.identity} target="_blank" rel="noreferrer">GitHub identity ↗</a> · <a href={candidate.latestObservation.sources.commits} target="_blank" rel="noreferrer">Commit evidence ↗</a></p>}
  </details>
}
export function DiscovererTable({leaders,compact=false,handles={}}){
  if(!leaders.length)return <p className="subtle-notice">No verified discoverer activity yet.</p>
  return <div className="growth-table-wrap"><table className="growth-table"><thead><tr><th>Discoverer</th><th>Fees earned</th><th>Reward-period volume</th><th>Launched</th><th>Graduated</th></tr></thead><tbody>{leaders.slice(0,compact?3:100).map(row=><tr key={row.wallet}>
    <td><WalletIdentity wallet={row.wallet} link={handles[row.wallet]} label="discoverer wallet"/>{!compact&&<details><summary>Markets & attribution</summary><ul className="discoverer-markets">{row.markets.map(m=><li key={m.repoId}><Link href={`/token/${m.mint}`}>{m.fullName}</Link><p>{m.enrolled?`Earned ${sol(m.earned)} · cap ${sol(m.cap)} · paid ${sol(m.paid)}`:'Launched before discovery enrollment'}</p><p>{m.enrolled?`Reward window: ${utcDateTime(m.launchedAt)} — ${utcDateTime(m.expiresAt)} (ends earlier at graduation or cap)`:`Launched ${utcDateTime(m.launchedAt)}`}</p><a href={`https://explorer.solana.com/tx/${m.signature}`} target="_blank" rel="noreferrer">Finalized launch ↗</a></li>)}</ul></details>}</td>
    <td>{sol(row.earned)}</td><td>{sol(row.volume)}</td><td>{row.launched}</td><td>{row.graduated}</td>
  </tr>)}</tbody></table></div>
}
export function GrowthMarketList({markets,kind,empty='No markets available yet.'}){
  const now=useNow()
  if(!markets.length)return <p className="growth-empty">{empty}</p>
  return <ul className="growth-market-list">{markets.map(m=><li key={m.repoId}><div><Link href={`/token/${m.mint}`}><strong>{m.fullName}</strong></Link>{kind==='trend'&&<p>{utcDateTime(m.launchedAt)} · <CopyAddress address={m.wallet} compact label="discoverer wallet"/></p>}</div>
    <span>{kind==='earned'?sol(m.earned):kind==='graduation'?(m.graduation&&stillValid(m.graduation.validUntil,now)?`${m.graduation.progressPercent}% · ${sol(m.graduation.remainingLamports)} remaining`:'Progress refreshing'):kind==='trend'?`${sol(m.volume)} volume · ${m.graduation&&stillValid(m.graduation.validUntil,now)?m.graduation.phase==='GRADUATED'?'Graduated':`${m.graduation.progressPercent}% to graduation`:'progress refreshing'}`:utcDate(m.launchedAt)}</span>
  </li>)}</ul>
}
function useGrowthData(initial){
  const [data,setData]=useState(initial)
  useEffect(()=>{
    let stopped=false,request=null
    async function refresh(){
      if(document.visibilityState!=='visible'||request)return
      request=new AbortController()
      try{const response=await fetch('/api/growth',{cache:'no-store',signal:request.signal});if(response.ok){const next=await response.json();if(!stopped)setData(next)}}catch{}finally{request=null}
    }
    const timer=setInterval(refresh,60000)
    document.addEventListener('visibilitychange',refresh)
    return()=>{stopped=true;clearInterval(timer);request?.abort();document.removeEventListener('visibilitychange',refresh)}
  },[])
  return data
}
export function ExploreGrowth({data:initial}){
  const data=useGrowthData(initial)
  return <div className="explore-growth">
    <div className="growth-grid"><section className="growth-section"><h2>New Markets</h2><GrowthMarketList markets={data.newMarkets}/></section>
      <section className="growth-section"><h2>Closest to Graduation</h2><GrowthMarketList markets={data.closest} kind="graduation" empty="Graduation progress is being verified."/></section>
      <section className="growth-section"><h2>Top Builder Earners</h2><GrowthMarketList markets={data.earners} kind="earned"/></section>
    </div>
    <section className="growth-section"><div className="growth-heading"><h2>Top Discoverers</h2><Link href="/discoverers">View all →</Link></div><DiscovererTable leaders={data.leaders} compact/>{data.leaderboardPartial&&<p className="growth-footnote">Some market attribution is being verified.</p>}</section>
  </div>
}
