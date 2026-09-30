'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Wrench } from 'lucide-react'
import { useWallet } from './wallet'
import { PartsDialog, centsLabel, postJson } from './parts-fund-dialog'
import { formatTokenAmount, formatUsdValue, parseUnits } from '../lib/format.mjs'

const API = '/api/parts-fund'
const FAILED = 'Pledge failed. Refresh and try again.'
const safeBase = (text, decimals) => { try { return parseUnits(text.trim(), decimals) } catch { return null } }
const usdFor = (token, baseUnits) => token?.usdPrice && baseUnits ? Number(baseUnits) / 10 ** token.decimals * token.usdPrice : null

// "Back this build": pledge USDC or SOL (≥ $5), optionally toward one part. One wallet approval; the pledge is held by
// the repo.ing tip wallet and either paid to the maintainer when the list is funded or refunded automatically.
export function BackBuild({ fund, fullName, className = 'button primary parts-back-cta' }) {
  const router = useRouter()
  const { wallet, connect, provider } = useWallet()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(null), [error, setError] = useState(''), [stage, setStage] = useState('')
  const [mint, setMint] = useState(null), [amount, setAmount] = useState(''), [itemId, setItemId] = useState('')
  const [busy, setBusy] = useState(false), [done, setDone] = useState(null)
  const trigger = useRef(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setError(''); setDone(null); setStage('')
    postJson(API, { action: 'view', fundId: fund.id }, FAILED).then(result => {
      if (!active) return
      setView(result)
      setMint(current => current ?? result.tokens.find(t => t.symbol === 'USDC' && t.minimumBaseUnits)?.mint ?? result.tokens.find(t => t.minimumBaseUnits)?.mint ?? null)
    }).catch(cause => active && setError(cause.message))
    return () => { active = false }
  }, [open, fund.id])

  function close() { if (busy) return; setOpen(false); trigger.current?.focus(); if (done) router.refresh() }

  const live = view?.fund ?? fund
  const token = view?.tokens.find(t => t.mint === mint) ?? null
  const baseUnits = token ? safeBase(amount, token.decimals) : null
  const usd = usdFor(token, baseUnits)
  const room = Math.max(0, live.goalCents - live.pledgedCents)
  const belowMinimum = Boolean(token?.minimumBaseUnits && baseUnits && BigInt(baseUnits) < BigInt(token.minimumBaseUnits))
  const overRoom = usd !== null && room > 0 && usd * 100 > Math.max(room, 500) + 0.5
  const canPledge = Boolean(token?.minimumBaseUnits && baseUnits && !belowMinimum && !overRoom && !busy && live.status === 'open' && room > 0)

  async function pledge() {
    if (!canPledge) return
    setBusy(true); setError(''); setStage('Preparing your pledge…')
    try {
      const address = wallet || await connect()
      const prepared = await postJson(API, { action: 'prepare', fundId: fund.id, revision: live.revision, itemId: itemId || null, wallet: address,
        mint: token.mint, amountBaseUnits: baseUnits }, FAILED)
      setStage('Approve the pledge in your wallet.')
      const { Transaction } = await import('@solana/web3.js')
      const signed = await provider().signTransaction(Transaction.from(Uint8Array.from(atob(prepared.transaction), c => c.charCodeAt(0))))
      setStage('Sending your pledge and waiting for Solana finality…')
      let result = await postJson(API, { action: 'submit', id: prepared.id, transaction: btoa(String.fromCharCode(...signed.serialize())) }, FAILED)
      for (let i = 0; result.state === 'pending' && i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        result = await postJson(API, { action: 'status', id: prepared.id }, FAILED)
      }
      if (result.state === 'confirmed') { setDone({ ...result, symbol: token.symbol, amount: baseUnits, decimals: token.decimals, usdCents: prepared.usdCents }); setStage('') }
      else if (result.state === 'pending') setStage('Your pledge was sent and is still confirming. It appears on this page once finalized.')
      else throw new Error(result.state === 'expired' ? 'The pledge expired before it landed. Nothing was sent; try again.' : 'The pledge transaction failed. Nothing was sent.')
    } catch (cause) { setError(cause?.message || FAILED); setStage('') }
    finally { setBusy(false) }
  }

  return <>
    <button ref={trigger} type="button" className={className} aria-haspopup="dialog" onClick={() => setOpen(true)}><Wrench size={16} aria-hidden="true"/>Back this build</button>
    {open && <PartsDialog eyebrow="Back this build" title={live.title} busy={busy} onClose={close}>
      {done ? <div className="tip-done" role="status"><Check size={26} aria-hidden="true"/><h3>Pledge confirmed</h3>
        <p>{formatTokenAmount(done.amount, done.decimals)} {done.symbol} ({centsLabel(done.usdCents)}) is held for {fullName}. If the list is funded by its deadline it goes to the maintainer; if not, it comes back to your wallet automatically.</p>
        {done.signature && <a href={`https://solscan.io/tx/${done.signature}`} target="_blank" rel="noopener noreferrer">View receipt on Solscan ↗</a>}
        <button type="button" className="button primary" onClick={close}>Done</button></div> : <>
        <p>All or nothing: pledges are paid to the maintainer only if the list reaches {centsLabel(live.goalCents)} by its deadline. Otherwise every pledge is refunded.</p>
        {!view && !error && <p className="tip-loading" role="status">Loading the parts list…</p>}
        {view && room <= 0 && <p className="parts-note" role="status">This list is fully pledged. It pays out at the deadline or when the maintainer collects.</p>}
        {view && room > 0 && <>
          <fieldset className="tip-tokens parts-tokens" disabled={busy}><legend>Pay with</legend>
            {view.tokens.map(t => <button type="button" key={t.mint} className={t.mint === mint ? 'selected' : ''} aria-pressed={t.mint === mint}
              disabled={!t.minimumBaseUnits} onClick={() => { setMint(t.mint); setAmount('') }}><strong>{t.symbol}</strong><small>{t.minimumBaseUnits ? t.name : 'Paused'}</small></button>)}
          </fieldset>
          {token && <label className="tip-amount"><span>Amount</span><span className="asset-input"><input inputMode="decimal" autoComplete="off"
            placeholder={formatTokenAmount(token.minimumBaseUnits, token.decimals).replaceAll(',', '')} value={amount} disabled={busy}
            onChange={event => setAmount(event.target.value.replace(/[^\d.]/g, ''))} aria-describedby="parts-amount-hint"/><span>{token.symbol}</span></span>
            <small id="parts-amount-hint" className={belowMinimum || overRoom ? 'tip-warning' : ''}>{usd !== null ? `≈ ${formatUsdValue(usd)} · ` : ''}{overRoom ? `Only ${centsLabel(room)} is left to pledge` : `Minimum ${formatTokenAmount(token.minimumBaseUnits, token.decimals)} ${token.symbol} (≈ $${view.minimumUsd}) · ${centsLabel(room)} left`}</small></label>}
          <label className="parts-select"><span>Put it toward</span><select value={itemId} disabled={busy} onChange={event => setItemId(event.target.value)}>
            <option value="">The whole list</option>
            {live.items.map(item => <option key={item.id} value={item.id} disabled={item.funded}>{item.name}{item.funded ? ' (funded)' : ''}</option>)}
          </select></label>
          <button type="button" className="button primary tip-submit" disabled={!canPledge} onClick={pledge}>{busy ? 'Working…' : token && baseUnits && !belowMinimum && !overRoom ? `Pledge ${formatTokenAmount(baseUnits, token.decimals)} ${token.symbol}` : 'Pledge'}</button>
        </>}
        {stage && <p className="transaction-status" role="status" aria-live="polite">{stage}</p>}
        {error && <p className="wallet-dialog-error" role="alert">{error}</p>}
        <p className="tip-fineprint">One wallet approval; you also pay the Solana network fee. Progress counts each pledge at its USD value when you pledge. Pledges are held in the public repo.ing tip wallet until the list pays out or refunds; you do not need to do anything to get a refund.</p>
      </>}
    </PartsDialog>}
  </>
}
