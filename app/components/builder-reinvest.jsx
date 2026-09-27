'use client'
import {useEffect,useRef,useState} from 'react'
import {useWallet} from './wallet'
import {CopyAddress} from './copy-address'
import {formatUnits} from '../lib/format.mjs'

export function reinvestAmount(text) {
  if(!/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(text)) return null
  const [whole,fraction='']=text.split('.')
  const n=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'))
  return n>0n?n:null
}
const sol = n => {const s=String(n).padStart(10,'0');return `${s.slice(0,-9)}.${s.slice(-9)}`.replace(/\.?0+$/,'')}
export function BuilderReinvest({repoId,claim,onClose}) {
  const {wallet,provider,connect}=useWallet()
  const walletRef=useRef(wallet);walletRef.current=wallet
  const [data,setData]=useState(null),[intent,setIntent]=useState(null),[value,setValue]=useState('')
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[cancelled,setCancelled]=useState(false),[now,setNow]=useState(Date.now())
  const matches=wallet===claim.wallet,selected=reinvestAmount(value)
  const remaining=data?BigInt(data.remaining):0n
  const submitted=intent?.status==='submitted',settled=intent?.status==='settled'
  const expires=intent&&Date.parse(intent.expiresAt)<=now
  async function refresh() {
    const response=await fetch(`/api/reinvest/${repoId}?wallet=${encodeURIComponent(claim.wallet)}&claim=${encodeURIComponent(claim.signature)}`,{cache:'no-store'})
    const next=await response.json()
    if(!response.ok||!Array.isArray(next.intents)) throw Error(next.error||'Reinvestment is not available yet.')
    setData(next)
    const latest=next.intents[0]
    if(latest&&['prepared','submitted','cancelling'].includes(latest.status))setIntent(latest)
    else setIntent(current=>current?next.intents.find(i=>i.id===current.id)??current:null)
    return next
  }
  useEffect(()=>{let active=true;refresh().catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[repoId,claim.signature])
  useEffect(()=>{const timer=setInterval(()=>{setNow(Date.now());if(intent&&['submitted','cancelling'].includes(intent.status))refresh().catch(e=>setError(e.message))},5000);return()=>clearInterval(timer)},[intent?.id,intent?.status])
  async function action(body) {
    const response=await fetch(`/api/reinvest/${repoId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,wallet:claim.wallet})})
    const result=await response.json()
    if(!response.ok)throw Error(result.error)
    return result.result
  }
  async function prepare() {
    if(!matches||!data?.enabled||!selected||selected>remaining)return
    setBusy('Simulating your reinvestment…');setError('');setCancelled(false)
    try {setIntent(await action({action:'prepare',claimSignature:claim.signature,sourceAmount:String(selected),idempotencyKey:crypto.randomUUID()}))}
    catch(e){setError(e.message);await refresh().catch(()=>{})}finally{setBusy('')}
  }
  async function approve() {
    if(!matches||!data?.enabled||!intent||expires)return
    setBusy('Approve the separate liquidity transaction in your wallet…');setError('')
    let signed
    try {
      const current=provider()
      if(current?.publicKey?.toBase58()!==claim.wallet)throw Error('Switch to your payout wallet before reinvesting.')
      const { Transaction } = await import('@solana/web3.js')
      signed=await current.signTransaction(Transaction.from(Uint8Array.from(atob(intent.transaction),c=>c.charCodeAt(0))))
      if(walletRef.current!==claim.wallet||provider()!==current)throw Error('Wallet changed. Reinvestment was not submitted by repo.ing.')
    } catch(e) {
      setError('Liquidity approval was not completed. Your claimed SOL stays in your wallet.')
      await action({action:'cancel',id:intent.id}).then(setIntent).catch(()=>{})
      setBusy('');return
    }
    try {
      setBusy('Liquidity submitted. Verifying settlement…')
      const bytes=signed.serialize()
      setIntent(await action({action:'submit',id:intent.id,termsHash:intent.termsHash,signedTransaction:btoa(String.fromCharCode(...bytes))}))
      await refresh()
    }catch(e){setError(`${e.message} Check the receipt before another attempt.`);await refresh().catch(()=>{})}
    finally{setBusy('')}
  }
  async function cancel() {
    setError('')
    if(intent?.status==='prepared'){
      setBusy('Cancelling the quote…')
      try {setIntent(await action({action:'cancel',id:intent.id}));setCancelled(true)}catch(e){setError(e.message)}finally{setBusy('')}
    } else {setCancelled(true);onClose?.()}
  }
  return <section className="inner-card reinvest-card" aria-label="Reinvest builder fees" aria-busy={Boolean(busy)}>
    <h2>{settled?'Reinvestment complete':'Reinvest builder fees'}</h2>
    <p className="positive">Claim complete · {formatUnits(claim.amount)} SOL received in your wallet.</p>
    {settled?<div className="claim-receipt" role="status"><div><p>{formatUnits(intent.settlement.economicDebit)} SOL reinvested into this repository’s pool.</p><p>You own this LP position and can withdraw it.</p><CopyAddress address={intent.position} label="LP position"/><a href={`https://explorer.solana.com/tx/${intent.signature}`} target="_blank" rel="noopener noreferrer">View liquidity transaction ↗</a></div></div>:
    <><p>Choose how much of this payout to add to the same repository’s graduated pool. Your wallet approves this separately. You own the resulting LP position.</p>
    {!matches&&<p className="inline-error">Connect your payout wallet to continue.</p>}
    {data&&!data.enabled&&<p role="status">New reinvestments are paused. Existing transactions can still be checked here.</p>}
    {!wallet&&<button className="button outline" onClick={()=>connect()}>Connect wallet</button>}
    {!intent||intent.status==='aborted'?<><label className="reinvest-amount-label" htmlFor={`reinvest-${repoId}`}>Amount to reinvest (SOL)</label>
      <input id={`reinvest-${repoId}`} inputMode="decimal" autoComplete="off" value={value} onChange={e=>setValue(e.target.value)} disabled={Boolean(busy)} placeholder="0.00"/>
      <div className="reinvest-presets">{[25,50,100].map(p=><button key={p} type="button" className="button outline" disabled={!data||Boolean(busy)} onClick={()=>setValue(sol(remaining*BigInt(p)/100n))}>{p}%</button>)}</div>
      <p className="muted">Available from this payout: {data?`${formatUnits(data.remaining)} SOL`:'Checking…'}. Network and account costs need additional SOL.</p>
      {selected&&selected>remaining&&data&&<p className="inline-error">Amount exceeds the unspent portion of this claim.</p>}
      <div className="reinvest-actions"><button type="button" className="button primary" disabled={!matches||!data?.enabled||!selected||selected>remaining||Boolean(busy)} onClick={prepare}>Review reinvestment</button><button type="button" className="button outline" disabled={Boolean(busy)} onClick={cancel}>Keep SOL in wallet</button></div></>:
    intent.status==='prepared'?<><dl className="reinvest-review"><div><dt>Maximum investment</dt><dd>{formatUnits(intent.terms.source_amount)} SOL</dd></div><div><dt>Estimated account and network costs</dt><dd>{formatUnits(intent.simulation.networkCost)} SOL</dd></div><div><dt>Maximum extra cost</dt><dd>{formatUnits(intent.terms.max_network_cost)} SOL</dd></div><div><dt>Slippage limit</dt><dd>1%</dd></div></dl>
      <CopyAddress address={intent.terms.pool} label="same repository pool"/><p className="muted">A balancing swap and liquidity deposit happen together. Remaining purchased tokens stay in your wallet.</p>
      {expires&&<p role="status">This quote expired. Cancel it, then refresh for a new review.</p>}
      <div className="reinvest-actions"><button className="button primary" disabled={!matches||!data?.enabled||Boolean(busy)||expires} onClick={approve}>Approve in wallet</button><button className="button outline" disabled={Boolean(busy)} onClick={cancel}>Cancel reinvestment</button></div></>:
    <p role="status">{submitted?'Submitted. Checking the exact transaction and your LP position…':'Reinvestment cancelled. Your claimed SOL stays in your wallet. Waiting for the old quote to expire before another attempt.'}</p>}
    {intent?.signature&&<a href={`https://explorer.solana.com/tx/${intent.signature}`} target="_blank" rel="noopener noreferrer">View liquidity transaction ↗</a>}
    {cancelled&&!intent&&<p role="status">Your claimed SOL stays in your wallet.</p>}</>}
    {busy&&<p className="claim-progress" role="status"><span className="claim-spinner" aria-hidden="true"/>{busy}</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {!busy&&<button className="claim-text-button" onClick={()=>refresh().catch(e=>setError(e.message))}>Refresh status</button>}
  </section>
}
