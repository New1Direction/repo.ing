'use client'
import { useRef,useState } from 'react'
import { useWallet } from './wallet'
const endpoint='/api/hook-lab/wallet-launch-assessment'
async function call(path,body){
 const response=await fetch(path,{cache:'no-store',credentials:'same-origin',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})
 const value=await response.json();if(!response.ok)throw Error(value.error||'Preparation review unavailable.');return value
}
export function HookWalletLaunchReview(){
 const {wallet,connect}=useWallet(),walletRef=useRef(wallet);walletRef.current=wallet
 const [id,setId]=useState(''),[preparation,setPreparation]=useState(null),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const running=useRef(false)
 const run=async task=>{if(running.current)return;running.current=true;setBusy(true);setError('');try{await task()}catch(cause){setError(cause.message);setResult(null)}finally{running.current=false;setBusy(false)}}
 const load=()=>run(async()=>{setPreparation(null);setResult(null);const value=await call(`${endpoint}?id=${encodeURIComponent(id)}`);setPreparation(value.preparation)})
 const review=()=>run(async()=>{
  const address=walletRef.current||await connect()
  if(address!==preparation.wallet)throw Error('Connect the wallet that owns this exact preparation.')
  const value=await call(endpoint,{preparationId:preparation.id,request:preparation.preparedRequest})
  if(walletRef.current!==address)throw Error('Connected wallet changed. Review again.')
  setResult(value)
 })
 return <section className="inner-card"><h2>Review a max-wallet launch</h2>
  <p>Load your retained preparation. Its mint, cap and signature stay fixed. This review does not submit or retry a transaction.</p>
  <label>Preparation ID <input value={id} onChange={event=>{setId(event.target.value);setPreparation(null);setResult(null)}} disabled={busy}/></label>
  <button disabled={busy||!id} onClick={load}>Load my preparation</button>
  {preparation&&<><dl><dt>Wallet</dt><dd>{preparation.wallet}</dd><dt>Mint</dt><dd>{preparation.mint}</dd><dt>Max-wallet cap</dt><dd>{preparation.preparedRequest.capBps} basis points</dd><dt>Original signature</dt><dd>{preparation.signature}</dd><dt>Retained status</dt><dd>{preparation.status}</dd></dl>
   <button disabled={busy} onClick={review}>{busy?'Checking…':'Refresh evidence and review launch gates'}</button></>}
  {result&&<div role="status"><p>Launch is blocked. No unsigned launch transaction was created.</p><ul>{result.blockers.map(blocker=><li key={blocker.code}>{blocker.message}</li>)}</ul></div>}
  {error&&<p role="alert">{error}</p>}
 </section>
}
