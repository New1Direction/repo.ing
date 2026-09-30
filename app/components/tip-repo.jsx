'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Gift, X } from 'lucide-react'
import { useWallet } from './wallet'
import { formatTokenAmount, formatUsdValue, parseUnits } from '../lib/format.mjs'

const post = async body => {
  const response = await fetch('/api/tips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Tip failed. Refresh and try again.')
  return result
}
const usdFor = (token, baseUnits) => token?.usdPrice && baseUnits ? Number(baseUnits) / 10 ** token.decimals * token.usdPrice : null
const safeBase = (text, decimals) => { try { return parseUnits(text.trim(), decimals) } catch { return null } }
const KIND_LABEL = { native: 'Crypto', stable: 'Stablecoin', xstock: 'Stock' }

// "Tip this repo": pick an approved token and amount, approve one transaction in your wallet. The tip is held by the
// repo.ing tip wallet until the verified maintainer claims it (or refundable to you after 90 days if unclaimed).
export function TipRepo({ repoId, fullName, className = 'button outline', label = null, ariaLabel }) {
  const router = useRouter()
  const { wallet, connect, provider } = useWallet()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState(null), [error, setError] = useState(''), [stage, setStage] = useState('')
  const [mint, setMint] = useState(null), [amount, setAmount] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(null)
  const dialog = useRef(null), trigger = useRef(null), working = useRef(false)

  useEffect(() => {
    if (!open) return
    let active = true
    setError(''); setDone(null); setStage('')
    post({ action: 'options', githubRepoId: repoId }).then(result => {
      if (!active) return
      setOptions(result)
      setMint(current => current ?? result.tokens.find(t => t.minimumBaseUnits)?.mint ?? null)
    }).catch(cause => active && setError(cause.message))
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector('button')?.focus()
    const onKey = event => {
      if (event.key === 'Escape' && !working.current) { event.preventDefault(); close() }
      if (event.key !== 'Tab' || !dialog.current) return
      const items = [...dialog.current.querySelectorAll('button:not(:disabled), input, a[href]')]
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { active = false; document.body.style.overflow = previous; document.removeEventListener('keydown', onKey) }
  }, [open, repoId])

  function close() { if (working.current) return; setOpen(false); trigger.current?.focus(); if (done) router.refresh() }

  const token = options?.tokens.find(t => t.mint === mint) ?? null
  const baseUnits = token ? safeBase(amount, token.decimals) : null
  const belowMinimum = Boolean(token?.minimumBaseUnits && baseUnits && BigInt(baseUnits) < BigInt(token.minimumBaseUnits))
  const usd = usdFor(token, baseUnits)
  const canTip = Boolean(token?.minimumBaseUnits && baseUnits && !belowMinimum && !busy)

  async function tip() {
    if (!canTip) return
    working.current = true; setBusy(true); setError(''); setStage('Preparing your tip…')
    try {
      const address = wallet || await connect()
      const prepared = await post({ action: 'prepare', githubRepoId: repoId, wallet: address, mint: token.mint, amountBaseUnits: baseUnits })
      setStage('Approve the tip in your wallet.')
      const { Transaction } = await import('@solana/web3.js')
      const signed = await provider().signTransaction(Transaction.from(Uint8Array.from(atob(prepared.transaction), c => c.charCodeAt(0))))
      setStage('Sending your tip and waiting for Solana finality…')
      let result = await post({ action: 'submit', id: prepared.id, transaction: btoa(String.fromCharCode(...signed.serialize())) })
      for (let i = 0; result.state === 'pending' && i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        result = await post({ action: 'status', id: prepared.id })
      }
      if (result.state === 'confirmed') { setDone({ ...result, symbol: token.symbol, amount: baseUnits, decimals: token.decimals }); setStage('') }
      else if (result.state === 'pending') setStage('Your tip was sent and is still confirming. It appears on this page once finalized.')
      else throw new Error(result.state === 'expired' ? 'The tip expired before it landed. Nothing was sent; try again.' : 'The tip transaction failed. Nothing was sent.')
    } catch (cause) { setError(cause?.message || 'Tip failed. Refresh and try again.'); setStage('') }
    finally { working.current = false; setBusy(false) }
  }

  return <>
    <button ref={trigger} type="button" className={className} aria-label={ariaLabel} aria-haspopup="dialog" onClick={() => setOpen(true)}><Gift size={16} aria-hidden="true"/>{label ?? 'Tip this repo'}</button>
    {open && <div className="wallet-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div ref={dialog} className="wallet-dialog tip-dialog" role="dialog" aria-modal="true" aria-labelledby="tip-dialog-title">
        <div className="wallet-dialog-heading"><div><span>Tip the maintainer</span><h2 id="tip-dialog-title">{fullName}</h2></div><button type="button" aria-label="Close tip dialog" disabled={busy} onClick={close}><X size={21}/></button></div>
        {done ? <div className="tip-done" role="status"><Check size={26} aria-hidden="true"/><h3>Tip sent</h3>
          <p>{formatTokenAmount(done.amount, done.decimals)} {done.symbol} is held for {fullName} until a verified maintainer claims it.</p>
          {done.signature && <a href={`https://solscan.io/tx/${done.signature}`} target="_blank" rel="noopener noreferrer">View receipt on Solscan ↗</a>}
          <button type="button" className="button primary" onClick={close}>Done</button></div> : <>
          <p>Send an approved token to this repository’s maintainer. repo.ing holds it in its tip wallet and pays it out when they verify on GitHub.</p>
          {!options && !error && <p className="tip-loading" role="status">Loading approved tokens…</p>}
          {options && <fieldset className="tip-tokens" disabled={busy}><legend>Token</legend>
            {options.tokens.map(t => <button type="button" key={t.mint} className={t.mint === mint ? 'selected' : ''} aria-pressed={t.mint === mint}
              disabled={!t.minimumBaseUnits} title={t.minimumBaseUnits ? `${t.name} · ${KIND_LABEL[t.kind]}` : `${t.name}: price unavailable, tips paused`}
              onClick={() => { setMint(t.mint); setAmount('') }}><strong>{t.symbol}</strong><small>{t.minimumBaseUnits ? KIND_LABEL[t.kind] : 'Paused'}</small></button>)}
          </fieldset>}
          {token && <label className="tip-amount"><span>Amount</span><span className="asset-input"><input inputMode="decimal" autoComplete="off" placeholder={formatTokenAmount(token.minimumBaseUnits, token.decimals).replaceAll(',', '')}
            value={amount} disabled={busy} onChange={event => setAmount(event.target.value.replace(/[^\d.]/g, ''))} aria-describedby="tip-amount-hint"/><span>{token.symbol}</span></span>
            <small id="tip-amount-hint" className={belowMinimum ? 'tip-warning' : ''}>{usd !== null ? `≈ ${formatUsdValue(usd)} · ` : ''}Minimum {formatTokenAmount(token.minimumBaseUnits, token.decimals)} {token.symbol} (≈ ${options.minimumUsd})</small></label>}
          <button type="button" className="button primary tip-submit" disabled={!canTip} onClick={tip}>{busy ? 'Working…' : token && baseUnits && !belowMinimum ? `Tip ${formatTokenAmount(baseUnits, token.decimals)} ${token.symbol}` : 'Tip this repo'}</button>
          {stage && <p className="transaction-status" role="status" aria-live="polite">{stage}</p>}
          {error && <p className="wallet-dialog-error" role="alert">{error}</p>}
          <p className="tip-fineprint">One wallet approval; you also pay the Solana network fee. Tips are custodial until claimed. If no maintainer claims within 90 days, you can refund an unclaimed tip from <a href="/wallet">your wallet page</a>.{token?.kind === 'xstock' && ' xStock amounts are base token units; your wallet may show a slightly higher scaled balance.'}</p>
        </>}
      </div>
    </div>}
  </>
}
