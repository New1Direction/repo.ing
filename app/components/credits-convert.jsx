'use client'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from './wallet'
import { formatUnits } from '../lib/format.mjs'

// "Claim as AI credits" (src/credits-web.mjs): SOL from the builder's wallet to repo.ing AI credits with one wallet approval.
// The server gets the quote, prepares the transfer and broadcasts the signed bytes; the credit service credits the payment.
export function creditsLamports(text) {
  const match = /^(\d{1,9})(?:\.(\d{1,9}))?$/.exec(String(text ?? '').trim())
  if (!match) return null
  const lamports = BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'))
  return lamports >= 10_000_000n && lamports <= 100_000_000_000n ? lamports : null
}
const sol = lamports => formatUnits(String(lamports))
const usd = micro => `$${(Number(BigInt(micro) / 10_000n) / 100).toFixed(2)}`
const left = (expiresAt, now) => {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const OPEN = ['quoted', 'prepared', 'submitted']

export function CreditsConvert({ repoId, claim = null, network = 'mainnet', onClose }) {
  const { wallet, provider, connect } = useWallet()
  const walletRef = useRef(wallet); walletRef.current = wallet
  const [conversion, setConversion] = useState(null), [loaded, setLoaded] = useState(false)
  const [value, setValue] = useState(claim ? sol(claim.amount) : ''), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const selected = creditsLamports(value)
  const open = conversion && OPEN.includes(conversion.status)
  const expired = conversion && Date.parse(conversion.expiresAt) <= now

  async function call(method, body) {
    const response = await fetch(`/api/credits/convert/${repoId}`, method === 'GET' ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw Error(result.error || 'AI credits are not available right now.')
    return result
  }
  async function refresh() {
    const result = await call('GET')
    setConversion(result.conversion); setLoaded(true)
    return result.conversion
  }
  useEffect(() => { let active = true; refresh().catch(e => { if (active) { setError(e.message); setLoaded(true) } }); return () => { active = false } }, [repoId])
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      if (conversion?.status === 'submitted') refresh().catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [conversion?.id, conversion?.status])

  async function quote() {
    if (!selected) return
    setBusy('Signing you in to AI credits and getting a quote…'); setError('')
    try { setConversion((await call('POST', { action: 'quote', lamports: String(selected) })).conversion) }
    catch (e) { setError(e.message); await refresh().catch(() => {}) }
    finally { setBusy('') }
  }
  async function approve() {
    setError('')
    let payer = walletRef.current
    try { payer = payer || await connect() } catch (e) { setError(e.message || 'Connect a wallet to pay.'); return }
    if (!payer) { setError('Connect a wallet to pay.'); return }
    setBusy('Preparing the payment…')
    let prepared, signed
    try {
      prepared = await call('POST', { action: 'prepare', id: conversion.id, payer })
      setConversion(prepared.conversion)
      setBusy('Approve the payment in your wallet…')
      const current = provider()
      if (current?.publicKey?.toBase58() !== payer) throw Error('Your wallet changed. Try again.')
      const { Transaction } = await import('@solana/web3.js')
      signed = await current.signTransaction(Transaction.from(Uint8Array.from(atob(prepared.transaction), c => c.charCodeAt(0))))
      if (walletRef.current !== payer) throw Error('Your wallet changed. Nothing was sent.')
    } catch (e) {
      setError(prepared ? 'The payment was not approved. Nothing was sent; your SOL stays in your wallet.' : e.message)
      setBusy(''); return
    }
    try {
      setBusy('Sending your payment…')
      const bytes = signed.serialize()
      setConversion((await call('POST', { action: 'submit', id: conversion.id, signedTransaction: btoa(String.fromCharCode(...bytes)) })).conversion)
    } catch (e) { setError(e.message); await refresh().catch(() => {}) }
    finally { setBusy('') }
  }
  async function cancel() {
    setError('')
    if (conversion?.status === 'quoted' || conversion?.status === 'prepared') {
      setBusy('Cancelling the quote…')
      try { setConversion((await call('POST', { action: 'cancel', id: conversion.id })).conversion) } catch (e) { setError(e.message) } finally { setBusy('') }
    } else onClose?.()
  }

  const devnet = network === 'devnet' && <p className="muted">Devnet test: set your wallet to Devnet before you approve.</p>
  return <section className="inner-card reinvest-card credits-card" aria-label="Convert to AI credits" aria-busy={Boolean(busy)}>
    <h2>{conversion?.status === 'credited' ? 'AI credits added' : 'Convert to AI credits'}</h2>
    {claim && <p className="positive">Claim complete · {sol(claim.amount)} SOL received in your wallet.</p>}
    {!loaded ? <p role="status">Checking your AI credits…</p> :
    conversion?.status === 'credited' ? <div className="claim-receipt" role="status"><div>
      <p>{usd(conversion.creditedMicro)} of AI credits added to your repo.ing account for {sol(conversion.lamports)} SOL.</p>
      <p>Use them in your coding tool: run <code>npx @repoing/cli credits key</code> to make a key.</p>
      <div className="credits-links">{conversion.signature && <a href={`https://explorer.solana.com/tx/${conversion.signature}${network === 'devnet' ? '?cluster=devnet' : ''}`} target="_blank" rel="noopener noreferrer">View payment ↗</a>}
        <button type="button" className="claim-text-button" onClick={() => setConversion(null)}>Convert more SOL</button></div></div></div> :
    conversion?.status === 'review' ? <p role="status">Your payment needs a review by repo.ing (wrong amount, late, or paid twice). Nothing is lost: you get a refund, or credits.</p> :
    open ? <>
      <dl className="reinvest-review">
        <div><dt>You pay</dt><dd>{sol(conversion.lamports)} SOL</dd></div>
        <div><dt>You get</dt><dd>{usd(conversion.creditMicro)} of AI credits</dd></div>
        <div><dt>SOL price</dt><dd>{usd(conversion.priceMicroPerSol)}</dd></div>
        {conversion.status !== 'submitted' && <div><dt>Quote expires in</dt><dd>{left(conversion.expiresAt, now)}</dd></div>}
      </dl>
      {devnet}
      {conversion.status === 'submitted' ? <>
        <p role="status">Payment sent. Waiting for it to finalize on chain; credits come right after.</p>
        <div className="credits-links">{conversion.signature && <a href={`https://explorer.solana.com/tx/${conversion.signature}${network === 'devnet' ? '?cluster=devnet' : ''}`} target="_blank" rel="noopener noreferrer">View payment ↗</a>}
          {!expired && <button type="button" className="claim-text-button" disabled={Boolean(busy)} onClick={approve}>Payment stuck? Approve again</button>}</div>
      </> : expired ? <p role="status">This quote expired. Nothing was charged.</p> : <>
        <p className="muted">Your wallet approves one payment to the repo.ing AI credits treasury. Credits buy AI model use in your coding tools; they never turn back into SOL.</p>
        <div className="reinvest-actions"><button type="button" className="button primary" disabled={Boolean(busy)} onClick={approve}>{wallet ? 'Approve in wallet' : 'Connect wallet and approve'}</button>
          <button type="button" className="button outline" disabled={Boolean(busy)} onClick={cancel}>Cancel</button></div>
      </>}
    </> : <>
      {conversion?.status === 'expired' && <p role="status">The last quote expired. Nothing was charged.</p>}
      {conversion?.status === 'cancelled' && <p role="status">Quote cancelled. Nothing was charged. A new quote is possible when the old one ends (at most 15 minutes).</p>}
      <p>Turn SOL into repo.ing AI credits for your coding tools, at the SOL price of the moment. Getting a quote signs you in to repo.ing AI credits with your GitHub account.</p>
      <label className="reinvest-amount-label" htmlFor={`credits-${repoId}`}>SOL to convert (0.01 to 100)</label>
      <input id={`credits-${repoId}`} inputMode="decimal" autoComplete="off" value={value} onChange={e => setValue(e.target.value)} disabled={Boolean(busy)} placeholder="0.00"/>
      {claim && <div className="reinvest-presets"><button type="button" className="button outline" disabled={Boolean(busy)} onClick={() => setValue(sol(claim.amount))}>All of this payout</button>
        <button type="button" className="button outline" disabled={Boolean(busy)} onClick={() => setValue(sol(BigInt(claim.amount) / 2n))}>Half</button></div>}
      {value && !selected && <p className="inline-error">Enter 0.01 to 100 SOL, with at most 9 decimals.</p>}
      {devnet}
      <div className="reinvest-actions"><button type="button" className="button primary" disabled={!selected || Boolean(busy)} onClick={quote}>Get quote</button>
        <button type="button" className="button outline" disabled={Boolean(busy)} onClick={cancel}>{claim ? 'Keep SOL in wallet' : 'Close'}</button></div>
      <p className="muted">Leave a little SOL for the network fee.</p>
    </>}
    {busy && <p className="claim-progress" role="status"><span className="claim-spinner" aria-hidden="true"/>{busy}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loaded && !busy && <div className="credits-links"><button type="button" className="claim-text-button" onClick={() => refresh().catch(e => setError(e.message))}>Refresh status</button></div>}
  </section>
}
