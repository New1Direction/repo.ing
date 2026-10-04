'use client'
import {useEffect,useState} from 'react'
import Link from 'next/link'
import {visiblePolling} from '../lib/visible-polling.mjs'
import {formatUnits} from '../lib/format.mjs'
const sol=value=>value===undefined||value===null?'—':`${formatUnits(value)} SOL`
const titles={OPS_WALLET_LOW:'Operating wallet needs SOL',LAUNCH_EXPIRED:'Expired launch released for retry',RESERVE_MOVED:'Reserve moved',PROGRESS_75:'75% of graduation target',PROGRESS_90:'90% of graduation target',GRADUATED:'Graduation verified',PARTNER_FEES_FIRST_ACCRUED:'First partner fees accrued',PLATFORM_CLAIM_AVAILABLE:'Platform fees available to claim',P3_FIRST_ELIGIBLE:'First P3 deployment ready for review',RECONCILIATION_MISMATCH:'Reconciliation needs review',GRADUATION_REVIEW:'Graduation evidence needs review',FEE_EVIDENCE_QUARANTINED:'Trade fee evidence needs review',TRADE_VERIFICATION_FAILED:'Trade verification failed',STOCK_GRADUATED:'Stock pair graduation verified',STOCK_GRADUATION_REVIEW:'Stock pair graduation needs review',STOCK_DAMM_SWAP_QUARANTINED:'Stock pair swap needs review'}
function ReserveMovement({detail}) {
  return <><small>{sol(detail.previousReserveLamports)} → {sol(detail.reserveLamports)} · {BigInt(detail.deltaLamports)>0n?'+':''}{sol(detail.deltaLamports)}</small>
    <small>{detail.phase==='GRADUATED'?'Graduated · DAMM SOL reserve':`${detail.progressPercent}% to graduation`} · Notification {detail.delivery.status}</small>
    <Link href={detail.url}>View market →</Link></>
}
export function GraduationOperations(){
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  async function refresh(){try{const r=await fetch('/api/operations/graduation',{cache:'no-store',signal:AbortSignal.timeout(10000)}),v=await r.json();if(!r.ok)throw Error(v.error);setData(v);setError('')}catch{setError('Readiness is unavailable. Retrying automatically.');setData(null)}}
  useEffect(()=>visiblePolling(refresh,15000),[])
  async function acknowledge(id){setBusy(true);try{const r=await fetch('/api/operations/graduation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'acknowledge',id})});if(!r.ok)throw Error('Acknowledgement failed');await refresh()}catch(e){setError(e.message)}finally{setBusy(false)}}
  return <><p className="muted">Finalized evidence and first-live checks. Spending is operator-reviewed and manual.</p>
    <div className="operations-toolbar"><span>{data?`Checked ${new Date(data.checkedAt).toLocaleTimeString()}`:'Checking readiness…'}</span><button className="button outline" onClick={refresh}>Refresh</button></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {data&&<><div className="operations-summary">
      <div className="inner-card"><span>Liquidity reserve</span><strong>{data.reconciliation.liquidity==='MATCH'?sol(data.reserve.remaining):'Needs review'}</strong></div>
      <div className="inner-card"><span>Platform fees claimed</span><strong>{sol(data.revenue.claimed.total)}</strong></div>
      <div className="inner-card"><span>Reconciliation</span><strong>{data.reconciliation.revenue} / {data.reconciliation.liquidity}</strong></div>
      <div className="inner-card"><span>Execution</span><strong>P3 {data.execution.p3?'ON':'OFF'} · P4 {data.execution.p4?'ON':'OFF'}</strong></div>
    </div><section className="inner-card operations-markets"><h2>Closest to graduation</h2><div className="operations-table-wrap"><table><thead><tr><th>Repository</th><th>Progress / phase</th><th>Partner fees</th><th>Reconciliation</th><th>P3 readiness</th></tr></thead><tbody>
      {data.markets.map(m=><tr key={m.repoId}><td><Link href={`/token/${m.mint}`}>{m.fullName}</Link><small>Repo {m.repoId}</small></td><td>{m.status==='VERIFIED'?<><strong>{m.phase} · {m.progressPercent.toFixed(2)}%</strong><small>{sol(m.reserveLamports)} / {sol(m.thresholdLamports)}</small>{m.phase==='CURVE'&&<small>{sol(m.remainingLamports)} remaining</small>}</>:<span>Needs review · {m.code}</span>}</td><td><span>{sol(m.platform?.earned)} earned</span><small>{sol(m.platform?.claimed)} claimed</small>{m.claimAvailable&&<small>Claim available</small>}</td><td>{m.reconciliation}</td><td>{m.p3?.eligible?<><strong>Ready for review</strong><small>Up to {sol(m.p3.maximumInvestment)}</small></>:m.p3?.reason}</td></tr>)}
    </tbody></table></div>{!data.markets.length&&<p>No indexed markets yet.</p>}</section>
    {data.stockMarkets?.length>0&&<section className="inner-card operations-markets"><h2>Stock pairs</h2><div className="operations-table-wrap"><table><thead><tr><th>Repository</th><th>Progress / phase</th><th>Graduated pool fees <small>(raw stock units)</small></th><th>Swap review</th></tr></thead><tbody>
      {data.stockMarkets.map(m=><tr key={m.repoId}><td><Link href={`/token/${m.mint}`}>{m.fullName}</Link><small>Repo {m.repoId} · {m.assetId}</small></td><td><strong>{m.phase}{m.progressPercent!==null&&` · ${m.progressPercent.toFixed(2)}%`}</strong>{m.observedAt&&<small>Read {new Date(m.observedAt).toLocaleString()}</small>}</td><td><span>{m.dammLauncherCredited} launcher</span><small>{m.dammAccumulatorCredited} accumulator</small></td><td>{m.openQuarantines?`${m.openQuarantines} quarantined`:'None'}</td></tr>)}
    </tbody></table></div></section>}
    <section className="inner-card operations-alerts"><h2>Operator alerts</h2>{data.alerts.length?data.alerts.map(a=><div key={a.id} className="operations-alert"><div><strong>{titles[a.kind]??a.kind}</strong><span>{a.fullName??'Protocol'} · {new Date(a.createdAt).toLocaleString()}</span>{a.kind==='RESERVE_MOVED'&&<ReserveMovement detail={a.detail}/ >}{a.kind==='OPS_WALLET_LOW'&&<small>{a.detail.role}: {sol(a.detail.balanceLamports)} · threshold {sol(a.detail.minimumLamports)} · Notification {a.detail.delivery.status}</small>}{a.detail.code&&<small>{a.detail.code}</small>}{(a.kind==='FEE_EVIDENCE_QUARANTINED'||a.kind==='STOCK_DAMM_SWAP_QUARANTINED')&&<small>{a.detail.signature} · {a.detail.reason}</small>}{a.kind==='TRADE_VERIFICATION_FAILED'&&<small>{a.detail.phase} · {a.detail.signature} · {a.detail.reason}</small>}</div><button className="button outline" disabled={busy||Boolean(a.acknowledgedAt)} onClick={()=>acknowledge(a.id)}>{a.acknowledgedAt?'Acknowledged':'Acknowledge'}</button></div>):<p>No alerts yet. Thresholds and events are recorded once, including while this page is closed.</p>}</section>
    <p className="muted">“Ready for review” does not enable spending. Follow the First Graduation runbook, then the bounded P3 runbook. P4 stays disabled until the first live P3 receipt and final MATCH.</p></>}
  </>
}
