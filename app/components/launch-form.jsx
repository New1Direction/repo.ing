'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, Image as ImageIcon, Info } from 'lucide-react'
import { TokenImagePicker } from './token-image-picker'
import { useWallet } from './wallet'
import { LaunchSuccess } from './launch-success'
import { TransactionStatus } from './ui'
import { launchDraftKey, readLaunchDraft, restoredPair, saveLaunchDraft } from '../lib/launch-draft.mjs'
import { formatUnits, parseUnits } from '../lib/format.mjs'
import { defaultTokenName, defaultTokenSymbol, tokenDetailsComplete } from '../lib/launch-defaults.mjs'
import { LAUNCH_FEE_SPLIT, launcherBuySentence, launchFeeSentence } from '../../src/launch-fee-copy.mjs'
import { verificationBonusTerms } from '../lib/verification-bonus-copy.mjs'
import { HF_DISCLAIMER } from '../../src/hf-copy.mjs'
import '../launch-pair.css'

const sol = value => `${formatUnits(value, 9)} SOL`
// A refusal by the fork guard (src/repo-lineage.mjs): final, so the form offers neither a retry nor a status check.
const COPY_REFUSED = 'COPY_OF_LAUNCHED_REPOSITORY'
// A launch transaction is valid for about 40 s from the review (150 blocks; src/launch-expiry.mjs), and the wallet's own
// review counts against it. A review older than this must be refreshed before signing, so the wallet keeps about 20 s.
const REVIEW_VALID_MS = 20_000
const cancelReview = id => fetch('/api/launch', { method: 'POST', keepalive: true,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', id }) }).catch(() => {})
async function launchRequest(body) {
  const response = await fetch('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error || 'Launch request failed'), {canRetry:result.canRetry,supportCode:result.supportCode,code:result.code})
  return result
}

// launchFee: launchFeeTerms() of the config this launch will use, or null when its fee is a flat 1.75%.
// verificationBonus: lamports this launch would be stamped with (VERIFICATION_BONUS_LAMPORTS), or null.
// A Hugging Face model market (repo.source 'huggingface', app/components/hf/model-launch.jsx) is prepared by its market id
// and registry _id (repo.hfId), and its review carries the community-launch disclaimer.
// quoteOptions: the pairs the server offers this repository (src/quote-assets.mjs quoteOptions). The pair chooser appears only
// when an eligible stock pair is among them; the launch then sends the chosen quoteAssetId and nothing else about it.
export function LaunchForm({ repo, available, discoveryEnabled = false, allocationEnabled = false, trendRevision, draft, launchFee = null, verificationBonus = null,
  quoteOptions = null }) {
  const model = repo.source === 'huggingface'
  const stockPair = model ? null : quoteOptions?.find(option => option.type === 'TOKENIZED_EQUITY' && option.eligible) ?? null
  const [quoteAssetId, setQuoteAssetId] = useState('sol')
  // A chosen stock pair is always sent, even if the server stops offering it before the launch is prepared: the server then
  // refuses it with its code. A pair is never dropped on the way, so a stock launch can never silently become SOL.
  const pairRequest = quoteAssetId === 'sol' ? {} : { quoteAssetId }
  const [name, setName] = useState(draft?.tokenName ?? defaultTokenName(repo.name))
  const [symbol, setSymbol] = useState(draft?.tokenSymbol ?? defaultTokenSymbol(repo.name))
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [failure, setFailure] = useState(null)
  const [copied, setCopied] = useState(false)
  const [draftReady, setDraftReady] = useState(null)
  const [draftRestored, setDraftRestored] = useState(false)
  const [pairDropped, setPairDropped] = useState(false)
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
  // Agent drafts ask the user to confirm an image, so they start expanded.
  const [customizing, setCustomizing] = useState(!!draft)
  const { wallet, connect, provider } = useWallet()
  const quoteKey = `${quoteAssetId}:${choice === 'custom' ? `custom:${customBuy}` : choice}`
  // A stock-paired launch has no initial buy yet (src/meteora-launch.mjs): the buy section is replaced by a note.
  const stockChosen = quoteAssetId !== 'sol'
  const noBuy = stockChosen || choice === 'none' || (choice === 'custom' && /^(?:0+(?:\.0*)?)?$/.test(customBuy.trim()))
  const quote = !noBuy && buyQuote?.key === quoteKey ? buyQuote : null
  const quoteError = !noBuy && buyError?.key === quoteKey ? buyError.message : ''
  const quoting = !noBuy && !quote && !quoteError
  const isDefault = !draft && name === defaultTokenName(repo.name) && symbol === defaultTokenSymbol(repo.name)
  const needsDetails = !tokenDetailsComplete({ name, symbol, image: tokenImage || imageBusy })
  const initialBuy = choice === 'none' ? '' : choice === 'custom' ? customBuy : quote ? formatUnits(quote.initialBuyLamports) : ''

  useEffect(() => { if (needsDetails) setCustomizing(true) }, [needsDetails])
  useEffect(() => {
    let saved=null
    try { if(!draft) saved=readLaunchDraft(window.sessionStorage,repo.repoId) } catch {}
    if(saved){
      const pair=restoredPair(saved,stockPair?.assetId)
      setName(saved.name);setSymbol(saved.symbol);setChoice(saved.choice);setCustomBuy(saved.customBuy);setTokenImage(saved.tokenImage)
      setQuoteAssetId(pair.quoteAssetId);setPairDropped(pair.pairDropped);setDraftRestored(true)
    }
    setDraftReady(repo.repoId)
  }, [repo.repoId, draft])
  useEffect(() => {
    if(draftReady!==repo.repoId)return
    try {
      if(launched)window.sessionStorage.removeItem(launchDraftKey(repo.repoId))
      else saveLaunchDraft(window.sessionStorage,repo.repoId,{name,symbol,choice,customBuy,quoteAssetId,tokenImage})
    }catch{}
  }, [draftReady,repo.repoId,name,symbol,choice,customBuy,quoteAssetId,tokenImage,launched])
  async function checkLaunchStatus(){
    setBusy(true)
    try{
      const r=await fetch(`/api/launch?repo=${encodeURIComponent(repo.repoId)}`,{cache:'no-store'}),v=await r.json()
      if(!r.ok)throw Error(v.error)
      if(v.state==='live'){window.location.assign(`/token/${v.mint}`);return}
      if(v.state==='retry'){setFailure(null);setError('');setStage('');setDraftRestored(true)}
      else setError('This launch is still being checked on Solana. If its transaction did not land, you can launch again in about two minutes. Check status again then.')
    }catch(cause){setError(cause.message||'Could not check launch status.')}
    finally{setBusy(false)}
  }
  async function copySupport(){try{await navigator.clipboard.writeText(`repo.ing · Repo ${repo.repoId} · ${failure.supportCode} · ${error}`);setCopied(true)}catch{setCopied(false)}}

  useEffect(() => {
    if (noBuy) return
    let active = true
    const timer = window.setTimeout(async () => {
      try {
        const body = choice === 'custom' ? { initialBuyLamports: parseUnits(customBuy.trim(), 9) } : { supplyBps: Number(choice) }
        const result = await launchRequest({ action: 'quote', ...body, ...pairRequest })
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
    const timer = setTimeout(() => setExpired(true), REVIEW_VALID_MS)
    return () => { clearTimeout(timer); cancelReview(review.id) }
  }, [review])
  useEffect(() => {
    if (review && wallet !== review.wallet) { setReview(null); setStage(''); setError('Wallet changed. Review the launch again.') }
  }, [wallet, review])

  async function prepare(event) {
    event.preventDefault()
    if (working.current || failure?.canRetry === false || quoting || quoteError || imageBusy || !tokenImage) return
    working.current = true; setBusy(true); setError(''); setFailure(null); setCopied(false)
    try {
      if (!available) throw new Error('Launch is temporarily unavailable. Please try again shortly.')
      const address = wallet || await connect()
      setStage('Checking launch costs')
      const initialBuyLamports = noBuy ? '0' : quote.initialBuyLamports
      const result = await launchRequest(model ? { action: 'prepare', repoId: repo.repoId, hfId: repo.hfId, agentDraft: draft?.token,
        tokenName: name, tokenSymbol: symbol, tokenImage: tokenImage.image, launcherWallet: address, initialBuyLamports }
        : { action: 'prepare', repoId: repo.repoId, trendRevision, agentDraft: draft?.token,
          repositoryUrl: `https://github.com/${repo.fullName}`, tokenName: name, tokenSymbol: symbol,
          tokenImage: tokenImage.image, launcherWallet: address, initialBuyLamports, ...pairRequest })
      setReview({ ...result, wallet: address, quote: stockChosen ? null : quote, pair: stockChosen ? stockPair?.symbol ?? quoteAssetId : null }); setStage('')
    } catch (cause) { setError(cause.message || 'Could not prepare launch'); setFailure({canRetry:cause.canRetry??true,code:cause.code??null,supportCode:cause.supportCode??'LAUNCH-CONNECTION'}); setStage('Failed') }
    finally { working.current = false; setBusy(false) }
  }
  async function approve() {
    let submitted=false
    if (working.current || !review || expired || wallet !== review.wallet) return
    working.current = true; setBusy(true); setError(''); setFailure(null); setCopied(false)
    try {
      setStage('Waiting for wallet')
      const { Transaction } = await import('@solana/web3.js')
      const transaction = Transaction.from(Uint8Array.from(atob(review.transaction), c => c.charCodeAt(0)))
      const signed = await provider().signTransaction(transaction)
      submitted=true
      setStage('Checking submission')
      const result = await launchRequest({ action: 'submit', id: review.id,
        transaction: btoa(String.fromCharCode(...signed.serialize({ requireAllSignatures: false, verifySignatures: true }))) })
      setStage('Confirmed'); setLaunched(result); setReview(null)
    } catch (cause) { setError(cause.message || 'Launch failed'); setFailure({canRetry:cause.canRetry??!submitted,supportCode:cause.supportCode??(submitted?'LAUNCH-CHECK-STATUS':'LAUNCH-WALLET')}); setStage('Failed'); setReview(null) }
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
  // A stock pair is never dropped on the way (pairRequest), so a confirmed launch with one chosen is that stock pair.
  if (launched) return <LaunchSuccess repo={repo} launched={launched} symbol={symbol} image={tokenImage?.image} quote={stockChosen ? { symbol: stockPair?.symbol ?? null } : null}/>
  return <form className="launch-panel" onSubmit={prepare}>
    {draftRestored && <p className="form-fineprint" role="status">Your saved launch details have been restored. Review current costs before signing.</p>}
    {pairDropped && <p className="form-fineprint" role="status">The stock pair you chose before is not offered for this repository right now, so this launch is paired with SOL.</p>}
    {draft && <p className="agent-review-note" role="status">Prepared with an agent. Review these details, choose an image, and approve the final costs in your wallet. Your signing wallet receives discovery attribution.</p>}
    <div className="launch-columns">
      <fieldset className="launch-fields launch-fieldset" disabled={busy || !!review}>
        <h2>Launch token</h2><p className="launch-subtitle">{model ? "Create a community market for this model. Every trade pays the model's owner." : 'Create a market for this repository. Every trade pays the builders.'}</p>
        <div className="launch-token-summary" role="group" aria-label="Token preview">
          <div className="preview-avatar">{tokenImage ? <img src={tokenImage.image} alt="Token artwork preview"/> : <ImageIcon size={24} aria-hidden="true"/>}</div>
          <div><strong>${symbol || 'TICKER'}</strong><span>{name || 'Token name'}</span>{imageBusy && !tokenImage ? <small>{model ? "Finding the owner's avatar…" : 'Finding a repository image…'}</small> : isDefault && <small>{model ? 'Suggested from this model' : 'Suggested from this repository'}</small>}</div>
        </div>
        <details className="launch-customize" open={customizing} onToggle={e => setCustomizing(e.currentTarget.open)}>
          <summary><span>Customize name, ticker &amp; image</span><ChevronDown size={18} aria-hidden="true"/></summary>
          <div className="launch-customize-body">
            <label className="field-label" htmlFor="token-name">Token name</label>
            <input id="token-name" className="field-input" maxLength={32} value={name} onChange={e => setName(e.target.value)} required/>
            <div className="field-hint"><span>This will be the name of your token.</span><span>{name.length}/32</span></div>
            <label className="field-label" htmlFor="token-symbol">Ticker</label>
            <input id="token-symbol" className="field-input" maxLength={10} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''))} required/>
            <div className="field-hint"><span>A short symbol for your token.</span><span>{symbol.length}/10</span></div>
            <div className="field-label">Token image</div>
            <TokenImagePicker repoId={repo.repoId} value={tokenImage} onChange={setTokenImage} onBusyChange={setImageBusy} disabled={busy || !!review} subject={model ? 'model' : 'repository'}/>
          </div>
        </details>
        {stockPair && <LaunchPair pair={stockPair} symbol={symbol} value={quoteAssetId} onChange={id => { setQuoteAssetId(id); setPairDropped(false); setError('') }}/>}
        {stockChosen ? <p className="launch-buy-hint launch-pair-buy-note" role="note">Stock-paired launches start without an initial buy. You can buy right after the launch.</p> : <>
        <label className="field-label" htmlFor="initial-buy">Initial buy <span className="muted">(optional)</span></label>
        <div className="launch-buy-presets" role="group" aria-label="Initial token allocation">
          {[[ 'none', 'No buy' ], [ '100', '1%' ], [ '200', '2%' ], [ '300', 'Max 3%' ]].map(([value, label]) =>
            <button key={value} type="button" aria-pressed={choice === value} onClick={() => { setChoice(value); setError('') }}>{label}</button>)}
        </div>
        <div className="input-suffix"><input id="initial-buy" placeholder={quoting ? 'Getting quote…' : '0.00'} inputMode="decimal" autoComplete="off" value={initialBuy}
          onChange={e => { setCustomBuy(e.target.value); setChoice('custom') }} aria-describedby="initial-buy-hint"/><span>SOL</span></div>
        <div className="field-hint">{wallet ? balance?.wallet === wallet ? balance.unavailable ? 'Wallet balance temporarily unavailable.' : `Wallet balance: ${sol(balance.lamports)}` : 'Checking wallet SOL balance…' : 'Connect your wallet to review launch costs.'}</div>
        <div id="initial-buy-hint" className="launch-buy-hint">Buy up to 3% of supply in the launch transaction. This limit applies to the initial buy; later market purchases are separate.{launchFee?.launcherBuyPercent && ` Your initial buy pays the regular ${launchFee.launcherBuyPercent} fee; the launch fee applies only to later trades.`}</div>
        <div className="launch-buy-quote" role="status" aria-live="polite">
          {quoting ? 'Calculating your initial buy…' : quote ? <>
            <strong>≈ {formatUnits(quote.tokenBaseUnits, 6, 0)} tokens · {(quote.supplyBps / 100).toFixed(2)}% of supply</strong>
            <span>Trading fee included: {sol(quote.tradingFeeLamports)}</span>
          </> : !quoteError ? 'No token purchase. You pay only launch account costs and the network fee.' : null}
        </div>
        {quoteError && <div className="inline-error" role="alert">{quoteError}</div>}
        </>}
      </fieldset>
      <div className="launch-side">
        {allocationEnabled && !stockChosen && (model ? <div className="inner-card discovery-launch"><h3>1% for the model&apos;s owner</h3><strong>10 million tokens reserved</strong><p>The model&apos;s verified owner on Hugging Face can claim this one-time allocation after graduation, in addition to trading fees. It comes from the fixed 1 billion supply.</p></div>
          : <div className="inner-card discovery-launch"><h3>1% for the builders</h3><strong>10 million tokens reserved</strong><p>The verified repository admin can claim this one-time allocation after graduation, in addition to trading fees. It comes from the fixed 1 billion supply.</p></div>)}
        {discoveryEnabled && !stockChosen && <div className="inner-card discovery-launch"><h3>Discovery rewards</h3><strong>Earn 50% of repo.ing’s trading fees</strong><p>Your launch wallet earns rewards on this market’s bonding-curve trades until graduation, 30 days, or 2.5 SOL earned—whichever comes first.</p><p>Rewards come from repo.ing’s existing share. Builder fees and the total trading fee stay the same. Claim in SOL from the market page by signing a message; repo.ing sends the reward and pays the network fee.</p></div>}
        {verificationBonus && !stockChosen && <div className="inner-card discovery-launch"><p style={{ margin: 0 }}><strong>Verification bonus:</strong> {verificationBonusTerms(verificationBonus)}</p></div>}
        <div className="inner-card fee-breakdown"><h3>Fee breakdown</h3><div className="fee-line"><span>Total DBC trading fee</span><strong>1.75%</strong></div><div className="fee-line">{model ? <span>Model owner share<small>Accrues for the model&apos;s verified owner</small></span> : <span>Repository creator share<small>Accrues for the verified repository owner</small></span>}<strong>0.994%</strong></div><div className="fee-line"><span>repo.ing share</span><strong>0.406%</strong></div><div className="fee-line"><span>Meteora protocol</span><strong>0.35%</strong></div>{launchFee && <div className="fee-line launch-fee-line"><span>Launch fee<small>First {launchFee.durationLabel} after launch, falling every second</small></span><strong>{launchFee.startPercent} → {launchFee.endPercent}</strong></div>}<div className="fee-note"><Info size={18}/><span>{launchFee ? `${launchFeeSentence(launchFee)} ${LAUNCH_FEE_SPLIT} ${launcherBuySentence(launchFee) ?? ''} ` : ''}Measured on the fixed Meteora bonding curve. Fee amounts round to whole token units per trade; rates after pool migration are not yet verified.</span></div></div>
      </div>
    </div>
    {review ? <section className="launch-review inner-card" aria-labelledby="launch-review-heading" aria-live="polite">
      <h3 id="launch-review-heading">Review your launch</h3>
      {tokenImage && <img className="launch-review-image" src={tokenImage.image} alt="Token artwork to be saved at launch"/>}
      <p>{name} · {symbol}{review.pair ? ` · Paired with ${review.pair}` : ''}{review.quote ? ` · ≈ ${(review.quote.supplyBps / 100).toFixed(2)}% initial allocation` : ' · No initial buy'}</p>
      <dl><div><dt>Initial buy <small>Trading fee included</small></dt><dd>{sol(review.costs.initialBuy)}</dd></div>
        <div><dt>Launch account deposits</dt><dd>{sol(review.costs.accountDeposits)}</dd></div>
        <div><dt>Network fee{BigInt(review.costs.priorityFee ?? '0') > 0n && <small>Includes {sol(review.costs.priorityFee)} priority fee</small>}</dt><dd>{sol(review.costs.networkFee)}</dd></div>
        <div className="launch-review-total"><dt>Estimated total</dt><dd>{sol(review.costs.total)}</dd></div></dl>
      <p>The launch and any initial buy happen together. The priority fee helps it land when Solana is busy. Check the final amount in your wallet.</p>
      {model && <p className="launch-review-disclaimer" role="note"><strong>{HF_DISCLAIMER}</strong></p>}
      {expired && <p role="status">This review expired. Refresh it for a fresh transaction, then approve it in your wallet right away.</p>}
      <div className="launch-review-actions"><button type="button" className="button primary" onClick={approve} disabled={busy || expired || wallet !== review.wallet}>{busy ? stage : 'Approve in wallet'}</button>
        <button type="button" className="button outline" disabled={busy} onClick={() => edit(expired)}>{expired ? 'Refresh review' : 'Edit launch'}</button></div>
    </section> : failure?.code === COPY_REFUSED ? null : failure?.canRetry === false ? <button type="button" className="button primary launch-submit" disabled={busy} onClick={checkLaunchStatus}>{busy?'Checking status…':'Check launch status'}</button> : <><button type="submit" className="button primary launch-submit" disabled={busy || quoting || !!quoteError || imageBusy || !tokenImage || !name || !symbol}>{busy ? stage : imageBusy ? 'Preparing image…' : failure ? 'Refresh review' : 'Review launch'}</button>
      <p className="form-fineprint">Review the total before signing. No platform launch fee.</p></>}
    <TransactionStatus stage={stage} error={error}/>
    {failure && <div className="launch-recovery"><p className="form-fineprint">{failure.code===COPY_REFUSED?'This repository cannot have its own market on repo.ing.':failure.canRetry?'Your launch details are saved. Refresh the review to try again.':'Your launch details are saved. Check the existing attempt before trying again.'}</p><div className="launch-review-actions"><code>{failure.supportCode}</code><button type="button" className="button outline" onClick={copySupport}>{copied?'Copied':'Copy support details'}</button></div></div>}
  </form>
}

// Choose pair: SOL (the default) or the stock of the company that owns this repository. The note names the instrument and
// its issuer's restriction without mentioning protocol liquidity, which belongs to the market page.
function LaunchPair({ pair, symbol, value, onChange }) {
  const stock = value === pair.assetId
  return <fieldset className="launch-pair">
    <legend className="field-label">Choose pair</legend>
    <div className="launch-pair-options">
      <label className={`launch-pair-option${stock ? '' : ' is-selected'}`}>
        <input type="radio" name="quote-asset" value="sol" checked={!stock} onChange={() => onChange('sol')}/>
        <span className="launch-pair-symbol">SOL</span><small>Default</small>
      </label>
      <label className={`launch-pair-option${stock ? ' is-selected' : ''}`}>
        <input type="radio" name="quote-asset" value={pair.assetId} checked={stock} onChange={() => onChange(pair.assetId)}/>
        <span className="launch-pair-symbol">{pair.symbol}</span><small>{pair.company}</small>
        <small className="launch-pair-why">Available because this repo belongs to {pair.githubOrg}</small>
      </label>
    </div>
    {stock && <p className="launch-pair-note" role="note"><strong>${symbol || 'TICKER'} / {pair.symbol}</strong> trades and pays its fees in {pair.symbol},
      tokenized {pair.company} stock{pair.provider === 'backed-xstocks' ? ' issued by Backed (xStocks), which are not available to U.S. persons' : ''}.
      Not affiliated with or endorsed by {pair.company}.</p>}
  </fieldset>
}
