'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Image as ImageIcon, Info } from 'lucide-react'
import { TokenImagePicker } from './token-image-picker'
import { useWallet } from './wallet'
import { InviteOwner } from './invite-owner'
import { ShareMarket } from './share-market'
import { CopyAddress } from './copy-address'
import { TransactionStatus } from './ui'
import { formatUnits, parseUnits } from '../lib/format.mjs'

const sol = value => `${formatUnits(value, 9)} SOL`
const cancelReview = id => fetch('/api/launch', { method: 'POST', keepalive: true,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', id }) }).catch(() => {})
async function launchRequest(body) {
  const response = await fetch('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Launch request failed')
  return result
}

export function LaunchForm({ repo, available, discoveryEnabled = false, allocationEnabled = false, trendRevision, draft }) {
  const [name, setName] = useState(draft?.tokenName ?? repo.name.slice(0, 32))
  const [symbol, setSymbol] = useState(draft?.tokenSymbol ?? repo.name.replace(/[^a-z0-9]/gi, '').slice(0, 10).toUpperCase())
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const [choice, setChoice] = useState(draft?.initialBuy ?? 'none')
  const [customBuy, setCustomBuy] = useState('')
  const [buyQuote, setBuyQuote] = useState(null)
  const [buyError, setBuyError] = useState(null)
  const [review, setReview] = useState(null)
  const [expired, setExpired] = useState(false)
  const [balance, setBalance] = useState(null)
  const [launched, setLaunched] = useState(null)
  const [tokenImage, setTokenImage] = useState(null)
  const [imageBusy, setImageBusy] = useState(true)
  const { wallet, connect, provider } = useWallet()
  const quoteKey = choice === 'custom' ? `custom:${customBuy}` : choice
  const noBuy = choice === 'none' || (choice === 'custom' && /^(?:0+(?:\.0*)?)?$/.test(customBuy.trim()))
  const quote = !noBuy && buyQuote?.key === quoteKey ? buyQuote : null
  const quoteError = !noBuy && buyError?.key === quoteKey ? buyError.message : ''
  const quoting = !noBuy && !quote && !quoteError
  const initialBuy = choice === 'none' ? '' : choice === 'custom' ? customBuy : quote ? formatUnits(quote.initialBuyLamports) : ''

  useEffect(() => {
    if (noBuy) return
    let active = true
    const timer = window.setTimeout(async () => {
      try {
        const body = choice === 'custom' ? { initialBuyLamports: parseUnits(customBuy.trim(), 9) } : { supplyBps: Number(choice) }
        const result = await launchRequest({ action: 'quote', ...body })
        if (active) { setBuyQuote({ ...result, key: quoteKey }); setBuyError(null) }
      } catch (cause) {
        if (active) { setBuyQuote(null); setBuyError({ key: quoteKey, message: cause.message || 'Quote unavailable' }) }
      }
    }, choice === 'custom' ? 350 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [choice, customBuy, noBuy, quoteKey])

  useEffect(() => {
    setBalance(null)
    if (!wallet) return
    let active = true
    fetch(`/api/wallet/balance?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() })
      .then(result => { if (active) setBalance({ wallet, lamports: result.lamports }) })
      .catch(() => { if (active) setBalance({ wallet, unavailable: true }) })
    return () => { active = false }
  }, [wallet, review])
  useEffect(() => {
    if (!review) return
    setExpired(false)
    const timer = setTimeout(() => setExpired(true), 45_000)
    return () => { clearTimeout(timer); cancelReview(review.id) }
  }, [review])
  useEffect(() => {
    if (review && wallet !== review.wallet) { setReview(null); setStage(''); setError('Wallet changed. Review the launch again.') }
  }, [wallet, review])

  async function prepare(event) {
    event.preventDefault()
    if (working.current || quoting || quoteError || imageBusy || !tokenImage) return
    working.current = true; setBusy(true); setError('')
    try {
      if (!available) throw new Error('Launch is temporarily unavailable. Please try again shortly.')
      const address = wallet || await connect()
      setStage('Checking launch costs')
      const initialBuyLamports = noBuy ? '0' : quote.initialBuyLamports
      const result = await launchRequest({ action: 'prepare', repoId: repo.repoId, trendRevision, agentDraft: draft?.token,
        repositoryUrl: `https://github.com/${repo.fullName}`, tokenName: name, tokenSymbol: symbol,
        tokenImage: tokenImage.image, launcherWallet: address, initialBuyLamports })
      setReview({ ...result, wallet: address, quote }); setStage('')
    } catch (cause) { setError(cause.message || 'Could not prepare launch'); setStage('Failed') }
    finally { working.current = false; setBusy(false) }
  }
  async function approve() {
    if (working.current || !review || expired || wallet !== review.wallet) return
    working.current = true; setBusy(true); setError('')
    try {
      setStage('Waiting for wallet')
      const { Transaction } = await import('@solana/web3.js')
      const transaction = Transaction.from(Uint8Array.from(atob(review.transaction), c => c.charCodeAt(0)))
      const signed = await provider().signTransaction(transaction)
      setStage('Submitted')
      const result = await launchRequest({ action: 'submit', id: review.id,
        transaction: btoa(String.fromCharCode(...signed.serialize())) })
      setStage('Confirmed'); setLaunched(result); setReview(null)
    } catch (cause) { setError(cause.message || 'Launch failed'); setStage('Failed'); setReview(null) }
    finally { working.current = false; setBusy(false) }
  }
  async function edit(refresh = false) {
    if (working.current) return
    working.current = true; setBusy(true)
    await cancelReview(review.id)
    setReview(null); setStage(''); setError('')
    working.current = false; setBusy(false)
    if (refresh) await prepare({ preventDefault() {} })
  }
  if (launched) return <section className="launch-panel launch-success" aria-live="polite"><CheckCircle2 size={43}/><h2>Success — repo has been tokenized</h2><p>{repo.fullName} has a live market. Copy its token address or open the market.</p><CopyAddress address={launched.mint}/><ShareMarket mint={launched.mint} symbol={symbol} fullName={repo.fullName} repoId={repo.repoId}/><InviteOwner repoId={repo.repoId} fullName={repo.fullName}/><Link className="button primary launch-submit" href={`/token/${launched.mint}`}>View market</Link></section>
  return <form className="launch-panel" onSubmit={prepare}>
    {draft && <p className="agent-review-note" role="status">Prepared with an agent. Review these details, choose an image, and approve the final costs in your wallet. Your signing wallet receives discovery attribution.</p>}
    <div className="launch-columns">
      <fieldset className="launch-fields launch-fieldset" disabled={busy || !!review}>
        <h2>Launch token</h2><p className="launch-subtitle">Create a market for this repository. Every trade pays the builders.</p>
        <label className="field-label" htmlFor="token-name">Token name</label>
        <input id="token-name" className="field-input" maxLength={32} value={name} onChange={e => setName(e.target.value)} required/>
        <div className="field-hint"><span>This will be the name of your token.</span><span>{name.length}/32</span></div>
        <label className="field-label" htmlFor="token-symbol">Ticker</label>
        <input id="token-symbol" className="field-input" maxLength={10} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''))} required/>
        <div className="field-hint"><span>A short symbol for your token.</span><span>{symbol.length}/10</span></div>
        <div className="field-label">Token image</div>
        <TokenImagePicker repoId={repo.repoId} value={tokenImage} onChange={setTokenImage} onBusyChange={setImageBusy} disabled={busy || !!review}/>
        <label className="field-label" htmlFor="initial-buy">Initial buy <span className="muted">(optional)</span></label>
        <div className="launch-buy-presets" role="group" aria-label="Initial token allocation">
          {[[ 'none', 'No buy' ], [ '100', '1%' ], [ '200', '2%' ], [ '300', 'Max 3%' ]].map(([value, label]) =>
            <button key={value} type="button" aria-pressed={choice === value} onClick={() => { setChoice(value); setError('') }}>{label}</button>)}
        </div>
        <div className="input-suffix"><input id="initial-buy" placeholder={quoting ? 'Getting quote…' : '0.00'} inputMode="decimal" autoComplete="off" value={initialBuy}
          onChange={e => { setCustomBuy(e.target.value); setChoice('custom') }} aria-describedby="initial-buy-hint"/><span>SOL</span></div>
        <div className="field-hint">{wallet ? balance?.wallet === wallet ? balance.unavailable ? 'Wallet balance temporarily unavailable.' : `Wallet balance: ${sol(balance.lamports)}` : 'Checking wallet SOL balance…' : 'Connect your wallet to review launch costs.'}</div>
        <div id="initial-buy-hint" className="launch-buy-hint">Buy up to 3% of supply in the launch transaction. This limit applies to the initial buy; later market purchases are separate.</div>
        <div className="launch-buy-quote" role="status" aria-live="polite">
          {quoting ? 'Calculating your initial buy…' : quote ? <>
            <strong>≈ {formatUnits(quote.tokenBaseUnits, 6, 0)} tokens · {(quote.supplyBps / 100).toFixed(2)}% of supply</strong>
            <span>Trading fee included: {sol(quote.tradingFeeLamports)}</span>
          </> : !quoteError ? 'No token purchase. You pay only launch account costs and the network fee.' : null}
        </div>
        {quoteError && <div className="inline-error" role="alert">{quoteError}</div>}
      </fieldset>
      <div className="launch-side">
        {allocationEnabled && <div className="inner-card discovery-launch"><h3>1% for the builders</h3><strong>10 million tokens reserved</strong><p>The verified repository admin can claim this one-time allocation after graduation, in addition to trading fees. It comes from the fixed 1 billion supply.</p></div>}
        {discoveryEnabled && <div className="inner-card discovery-launch"><h3>Discovery rewards</h3><strong>Earn 50% of repo.ing’s trading fees</strong><p>Your launch wallet earns rewards on this market’s bonding-curve trades until graduation, 30 days, or 2.5 SOL earned—whichever comes first.</p><p>Rewards come from repo.ing’s existing share. Builder fees and the total trading fee stay the same. Claim in SOL from the market page; your wallet pays network and account setup costs.</p></div>}
        <div className="inner-card"><h3>Token preview</h3><div className="preview-token"><div className="preview-avatar">{tokenImage ? <img src={tokenImage.image} alt="Token artwork preview"/> : <ImageIcon size={30}/>}</div><div><strong>{symbol || 'TOKEN'}</strong><span>{name || 'Token name'}</span></div></div><div className="badge-line"><span className="small-chip">Repository token</span><span className="small-chip">Community owned</span></div></div>
        <div className="inner-card fee-breakdown"><h3>Fee breakdown</h3><div className="fee-line"><span>Total DBC trading fee</span><strong>1.75%</strong></div><div className="fee-line"><span>Repository creator share<small>Accrues for the verified repository owner</small></span><strong>0.994%</strong></div><div className="fee-line"><span>repo.ing share</span><strong>0.406%</strong></div><div className="fee-line"><span>Meteora protocol</span><strong>0.35%</strong></div><div className="fee-note"><Info size={18}/><span>Measured on the fixed Meteora bonding curve. Fee amounts round to whole token units per trade; rates after pool migration are not yet verified.</span></div></div>
      </div>
    </div>
    {review ? <section className="launch-review inner-card" aria-labelledby="launch-review-heading" aria-live="polite">
      <h3 id="launch-review-heading">Review your launch</h3>
      {tokenImage && <img className="launch-review-image" src={tokenImage.image} alt="Token artwork to be saved at launch"/>}
      <p>{name} · {symbol}{review.quote ? ` · ≈ ${(review.quote.supplyBps / 100).toFixed(2)}% initial allocation` : ' · No initial buy'}</p>
      <dl><div><dt>Initial buy <small>Trading fee included</small></dt><dd>{sol(review.costs.initialBuy)}</dd></div>
        <div><dt>Launch account deposits</dt><dd>{sol(review.costs.accountDeposits)}</dd></div>
        <div><dt>Network fee</dt><dd>{sol(review.costs.networkFee)}</dd></div>
        <div className="launch-review-total"><dt>Estimated total</dt><dd>{sol(review.costs.total)}</dd></div></dl>
      <p>The launch and any initial buy happen together. Check the final amount in your wallet.</p>
      {expired && <p role="status">This review expired. Edit and review again for a fresh transaction.</p>}
      <div className="launch-review-actions"><button type="button" className="button primary" onClick={approve} disabled={busy || expired || wallet !== review.wallet}>{busy ? stage : 'Approve in wallet'}</button>
        <button type="button" className="button outline" disabled={busy} onClick={() => edit(expired)}>{expired ? 'Refresh review' : 'Edit launch'}</button></div>
    </section> : <><button type="submit" className="button primary launch-submit" disabled={busy || quoting || !!quoteError || imageBusy || !tokenImage || !name || !symbol}>{busy ? stage : imageBusy ? 'Preparing image…' : 'Review launch'}</button>
      <p className="form-fineprint">Review the total before signing. No platform launch fee.</p></>}
    <TransactionStatus stage={stage} error={error}/>
  </form>
}
