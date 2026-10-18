'use client'
import { useRef,useState } from 'react'
import { useWallet } from './wallet'
import { newMintReviewInput,newMintReviewProjection } from '../lib/hooklab-new-mint-client.mjs'
export function HookNewMintReview(){
 const {wallet,connect}=useWallet(),walletRef=useRef(wallet);walletRef.current=wallet
 const [id,setId]=useState(''),[cap,setCap]=useState(''),[label,setLabel]=useState(''),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),running=useRef(false)
 const review=async()=>{
  if(running.current)return;running.current=true;setBusy(true);setResult(null);setError('')
  try{
   const address=walletRef.current||await connect(),operationId=id||crypto.randomUUID();setId(operationId)
   const input=newMintReviewInput({operationId,wallet:address,capBps:cap,label})
   const response=await fetch('/api/hook-lab/new-mint-preparation',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})
   const value=await response.json();if(!response.ok)throw Error(value.error||'Preparation unavailable.')
   if(walletRef.current!==address)throw Error('Connected wallet changed. Review again with the same operation ID.')
   setResult(newMintReviewProjection(value,{operationId,wallet:address}))
  }catch(cause){setError(cause.message)}finally{running.current=false;setBusy(false)}
 }
 return <section className="inner-card"><h2>Prepare a new max-wallet coin</h2>
  <p>Review a new mint or resume the same operation. Keep the operation ID: never start a replacement after an uncertain transaction.</p>
  <label>Operation ID (optional for first review)<input value={id} disabled={busy} onChange={e=>{setId(e.target.value);setResult(null)}}/></label>
  <label>Max-wallet cap in basis points<input value={cap} disabled={busy} onChange={e=>{setCap(e.target.value);setResult(null)}} inputMode="numeric"/></label>
  <label>Label<input value={label} disabled={busy} onChange={e=>{setLabel(e.target.value);setResult(null)}}/></label>
  <button disabled={busy} onClick={review}>{busy?'Checking preparation…':'Review preparation gates'}</button>
  {result&&<div role="status"><p>{result.status==='blocked'?'Preparation is blocked. No mint was reserved.':'Candidate preparation only. No signing or submission is available.'}</p>
   <p>Operation: {result.operationId}</p>{result.mint&&<p>Mint: {result.mint}</p>}
   <ul>{result.blockers.map(item=><li key={item.code}>{item.message}</li>)}</ul></div>}
  {error&&<p role="alert">{error}</p>}
 </section>
}
