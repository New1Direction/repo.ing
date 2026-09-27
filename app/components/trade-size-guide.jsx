'use client'
import { useState } from 'react'
import { formatSolDisplay } from '../lib/format.mjs'
export function TradeSizeGuide({ repoId, disabled, onSelect }) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function load() {
    setBusy(true);setError('')
    try {
      const response=await fetch('/api/trade',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'depth',githubRepoId:repoId})})
      const result=await response.json()
      if(!response.ok)throw Error('Size guide is temporarily unavailable. Enter an amount for a live quote.')
      setData(result)
    }catch(cause){setError(cause.message)}finally{setBusy(false)}
  }
  const exactSol = value => { const n=BigInt(value); return `${n/1000000000n}.${String(n%1000000000n).padStart(9,'0')}` }
  return <details className="trade-size-guide" onToggle={e=>{if(e.currentTarget.open&&!busy)void load()}}><summary>Trade size guide</summary>
    <p>Estimated buy sizes for 1% or 3% price impact, excluding fees. Your quote refreshes before signing.</p>
    {busy?<small role="status">Checking current liquidity…</small>:<div className="trade-quick-actions">{data?.sizes.map(item=><button key={item.percent} type="button" disabled={disabled||item.amountLamports==='0'} onClick={()=>onSelect(exactSol(item.amountLamports))}>~{item.percent}% · {formatSolDisplay(item.amountLamports)} SOL</button>)}{data&&<button type="button" disabled={disabled} onClick={load}>Refresh</button>}</div>}
    {error&&<small role="status">{error}</small>}
  </details>
}
