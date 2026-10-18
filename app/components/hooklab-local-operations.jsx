'use client'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from './wallet'
const endpoint='/api/hook-lab/local-operations',storage='repo.ing.hooks.local-operation.v1'
const pending=new Set(['submission-claimed','submitted','outcome-unknown'])
const encode=bytes=>btoa(String.fromCharCode(...bytes)),decode=text=>Uint8Array.from(atob(text),x=>x.charCodeAt(0))
async function call(body){const response=await fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok||value.status!=='available')throw Error(value.error||'Local operation unavailable; preserve its ID');return value}
export function HookLocalOperations({genesisHash}){
 const {wallet,provider}=useWallet(),walletRef=useRef(wallet);walletRef.current=wallet
 const [mint,setMint]=useState(''),[kind,setKind]=useState('prepare-trading'),[id,setId]=useState(''),[operation,setOperation]=useState(null)
 const operationRef=useRef(operation);operationRef.current=operation
 const [busy,setBusy]=useState(false),[accepted,setAccepted]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState('')
 const running=useRef(false)
 useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem(storage));if(saved&&/^[0-9a-f-]{36}$/.test(saved.id)){setId(saved.id);setMint(saved.mint);setKind(saved.kind);setUncertain(true)}}catch{}},[])
 useEffect(()=>{setAccepted(false);setOperation(null);if(id)setUncertain(true)},[wallet])
 function receive(value){if(value.operation){if(value.operation.owner!==walletRef.current){setUncertain(true);throw Error('Reconnect the retained operation’s wallet before continuing')}setOperation(value.operation);setUncertain(pending.has(value.operation.status));setAccepted(false)}}
 async function run(action){if(running.current)return;running.current=true;setBusy(true);setError('');try{await action()}catch(cause){setError(cause.message)}finally{running.current=false;setBusy(false)}}
 const act=action=>run(async()=>{if(!walletRef.current||(operation&&operation.owner!==walletRef.current))throw Error('Reconnect the retained operation’s wallet');if(action==='submit'||action==='cosign')setUncertain(true);receive(await call({action,signingId:id}))})
 useEffect(()=>{if(!operation||!pending.has(operation.status)||busy)return;const timer=setTimeout(()=>{void run(async()=>receive(await call({action:'reconcile',signingId:id})))},8000);return()=>clearTimeout(timer)},[operation?.status,operation?.revision,busy,id])
 const review=retained=>run(async()=>{
  if(retained){const saved=JSON.parse(localStorage.getItem(storage));if(saved?.id!==id||saved.mint!==mint||saved.kind!==kind)throw Error('Retained local intent changed; preserve the original signing ID')}
  const next=retained?id:crypto.randomUUID();localStorage.setItem(storage,JSON.stringify({id:next,mint,kind}));setId(next);setOperation(null);setUncertain(true)
  receive(await call({action:'review',signingId:next,request:{mint,kind}}))
 })
 const signReview=()=>run(async()=>{
  const address=walletRef.current,reviewed=operation.review
  if(!accepted||Date.now()>=reviewed.reviewExpiresAtMs)throw Error('Accept the current unexpired review first')
  const value=await call({action:'wallet-request',signingId:id}),review=value.review
  if(walletRef.current!==address||operationRef.current?.id!==id||review.messageSha256!==reviewed.messageSha256||review.wallet!==address||review.genesisHash!==genesisHash)throw Error('Wallet, network or reviewed operation changed')
  setOperation(current=>current?.id===id?{...current,walletRequestIssued:true}:current)
  const {VersionedTransaction}=await import('@solana/web3.js'),tx=VersionedTransaction.deserialize(decode(value.partialTransactionBase64)),message=tx.message.serialize()
  if(encode(message)!==review.messageBase64)throw Error('Message differs from issued review')
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',message))].map(x=>x.toString(16).padStart(2,'0')).join('')
  if(hash!==reviewed.messageSha256||walletRef.current!==address||operationRef.current?.id!==id)throw Error('Message, active wallet or reviewed operation changed')
  const prior=tx.signatures.map(s=>encode(s)),signed=await provider().signTransaction(tx)
  if(walletRef.current!==address||operationRef.current?.id!==id||encode(signed.message.serialize())!==encode(message))throw Error('Wallet or reviewed operation changed')
  for(let i=0;i<prior.length;i++)if(review.requiredSigners[i]!==address&&encode(signed.signatures[i])!==prior[i])throw Error('Wallet changed another signature')
  receive(await call({action:'retain-wallet',signingId:id,signedTransactionBase64:encode(signed.serialize())}))
 })
 const active=(!operation&&uncertain)||(operation&&!['finalized-success','finalized-failure'].includes(operation.status)),quote=operation?.request?.quote
 return <section className="inner-card" aria-label="Local trading account and fee collection">
  <h2>Local trading account & fee collection</h2>
  <p>LOCAL ONLY. First create your native base-token holding, then use the buy/sell form above. Collection pays existing accrued fees to their pinned recipients; it adds no surcharge. Sign in with your local wallet above first.</p>
  <fieldset disabled={busy||active}><label>Local operation<select value={kind} onChange={e=>setKind(e.target.value)}><option value="prepare-trading">Prepare trading account</option><option value="collect-fees">Collect creator and platform fees</option></select></label>
   <label>Local launched mint<input value={mint} onChange={e=>setMint(e.target.value)} maxLength={44}/></label></fieldset>
  <button disabled={busy||!wallet||!mint||active} onClick={()=>review(false)}>Review local operation</button>
  {id&&<><p>Retained local signing ID: <code>{id}</code></p><button disabled={busy||!wallet} onClick={()=>act('get')}>Refresh saved local operation</button>
   {!operation&&<button disabled={busy||!wallet} onClick={()=>review(true)}>Resume retained local review</button>}</>}
  {uncertain&&!operation&&<p role="status">Refresh the retained local operation before starting another. Reloading never grants permission to resend.</p>}
  {operation&&<><h3>Local operation: {operation.status}</h3><p>Message SHA-256: <code>{operation.messageSha256}</code></p>
   <p>Exact native fee: {operation.review.baseFeeLamports} lamports. Maximum native debit including account rent: {operation.review.maxNativeDebitLamports} lamports.</p>
   {quote&&<dl><dt>Creator claim, raw quote</dt><dd>{quote.creatorDue}</dd><dt>Platform collection, raw quote</dt><dd>{quote.platformDue}</dd><dt>Pinned platform recipient</dt><dd><code>{quote.collector}</code></dd></dl>}
   <details><summary>Exact reviewed accounts and signer order</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({accounts:operation.review.accounts,signers:operation.review.requiredSigners,expires:new Date(operation.review.reviewExpiresAtMs).toISOString()},null,2)}</pre></details>
   <label><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} disabled={busy}/><span>I reviewed these LOCAL-only bytes, amounts, recipients and fee ceiling.</span></label>
   <button disabled={busy||uncertain||!accepted||operation.status!=='reviewed'} onClick={signReview}>Sign reviewed local transaction</button>
   <button disabled={busy||uncertain||operation.status!=='partial'} onClick={()=>act('cosign')}>Complete local admin signature</button>
   <button disabled={busy||uncertain||operation.status!=='signed'} onClick={()=>act('submit')}>Submit local transaction once</button>
   <button disabled={busy||(!uncertain&&!pending.has(operation.status)&&!operation.signature)} onClick={()=>act('reconcile')}>Verify original local receipt</button>
   <button disabled={busy||operation.walletRequestIssued||operation.status!=='reviewed'} onClick={()=>act('refresh-review')}>Refresh unsigned local review</button>
   {operation.signature&&<p>Local transaction: <code>{operation.signature}</code></p>}
   {operation.settlement&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(operation.settlement,null,2)}</pre>}
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>
}
