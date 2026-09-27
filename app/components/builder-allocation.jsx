'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CopyAddress } from './copy-address'

export function BuilderAllocation({ repoId }) {
  const [data,setData] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const endpoint = `/api/allocation/${repoId}`
  async function refresh() {
    const response = await fetch(endpoint,{cache:'no-store'})
    const next = await response.json()
    if (!response.ok) throw Error(next.error)
    setData(next); setError('')
  }
  useEffect(()=>{let active=true; let timer; async function poll(){try{await refresh()}catch(cause){if(active)setError(cause.message)}if(active)timer=setTimeout(poll,10000)}poll();return()=>{active=false;clearTimeout(timer)}},[endpoint])
  async function claim() {
    setBusy(true);setError('')
    try {
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({review:data.review})})
      const result=await response.json()
      if(!response.ok)throw Error(result.error)
      setData(current=>({...current,state:result.status,receipt:result,review:null}))
    }catch(cause){setError(cause.message)}finally{setBusy(false)}
  }
  if(data?.enrolled===false)return null
  return <section className="inner-card builder-allocation"><div className="card-heading"><h3>Builder allocation · 1%</h3><span className="small-chip">{data?.state==='settled'?'Claimed':data?.state==='pending'?'Confirming':data?.state==='available'?'Unlocked':data?.state==='locked'?'Locked':'Checking'}</span></div>
    <strong>10,000,000 tokens</strong><p>A one-time allocation from the fixed supply, reserved for the verified repository admin. Unlocks after graduation. Trading fees are separate.</p>
    {data?.wallet&&<div className="discovery-recipient"><span>Saved payout wallet</span><CopyAddress address={data.receipt?.wallet??data.wallet} label="allocation recipient"/></div>}
    {busy||data?.state==='pending'?<p className="claim-progress" role="status"><span className="claim-spinner"/>Checking and confirming your token payout…</p>:data?.state==='settled'?<p className="positive" role="status">Your 10 million token allocation was paid.</p>:data?.review?<button className="button primary" onClick={claim}>Claim 10 million tokens</button>:data?.state==='available'?<Link className="button outline" href={`/claim/${repoId}`}>Verify GitHub & set payout wallet</Link>:data?.state==='locked'?<p className="subtle-notice">The allocation stays reserved until this market graduates.</p>:<p role="status">Checking allocation…</p>}
    {data?.receipt?.signature&&<a className="claim-text-button" href={`https://explorer.solana.com/tx/${data.receipt.signature}`} target="_blank" rel="noreferrer">View payout receipt ↗</a>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </section>
}
