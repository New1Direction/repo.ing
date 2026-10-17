'use client'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from './wallet'
import { HookWalletSignIn } from './hooklab-wallet-signin'
const endpoint = '/api/hook-lab/inclusive-trade'
const storageKey = 'repo.ing.hooks.inclusive-trade.signing-id.v1'
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const pending = new Set(['submitted', 'submission-claimed', 'outcome-unknown'])
const encode = bytes => btoa(String.fromCharCode(...bytes))
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
async function call(body) {
  const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let value
  try { value = await response.json() } catch { throw Error('Response interrupted. Keep your signing ID and refresh the original trade.') }
  if (value.status === 'blocked') return value
  if (!response.ok || value.status !== 'available') throw Error(value.error || 'Trade unavailable. Refresh the original signing ID before continuing.')
  return value
}
export function HookInclusiveTrade({ genesisHash, initialBlockers = [] }) {
  const { wallet, connect, provider } = useWallet()
  const walletRef = useRef(wallet); walletRef.current = wallet
  const running = useRef(false)
  const [identity, setIdentity] = useState(null), [id, setId] = useState(''), [completedId,setCompletedId] = useState('')
  const [form, setForm] = useState({ mint: '', selectedConfig: '', capBps: '', creatorFeeBps: '', side: 'buy', amountIn: '', minAmountOut: '', maxInput: '', maxPriceImpactBps: '' })
  const [operation, setOperation] = useState(null), [blockers, setBlockers] = useState(initialBlockers)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [accepted, setAccepted] = useState(false), [now, setNow] = useState(Date.now())
  const authenticated = !!wallet && identity?.wallet === wallet
  const intent = operation?.request, quote = intent?.quote, review = operation?.review
  const verifiedQuote = !!quote && quote.feeModel === 2 && quote.protocolShareBps === 2500 && Number.isInteger(quote.creatorFeeBps) && ['delivered', 'minAmountOut', 'protocolFee', 'grossCreatorFee', 'netCreatorFee'].every(key => typeof quote[key] === 'string' && /^\d+$/.test(quote[key]))
  const expired = !!review && now >= review.reviewExpiresAtMs
  const canAct = authenticated && !busy && !uncertain && !blockers.length && verifiedQuote
  useEffect(() => {
    try { const saved = localStorage.getItem(storageKey); if (uuid(saved)) setId(saved); const completed=localStorage.getItem(storageKey+'.last-completed'); if(uuid(completed))setCompletedId(completed) } catch {}
    const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer)
  }, [])
  useEffect(() => { setOperation(null); setAccepted(false) }, [wallet])
  function retain(value) { localStorage.setItem(storageKey, value); setId(value) }
  function receive(value, expectedId = id) {
    if (value.status === 'blocked') { setBlockers(value.blockers || []); setAccepted(false); return false }
    const op = value.operation
    if (!op || op.id !== expectedId || op.custodyOperationId !== expectedId || !['inclusive-buy', 'inclusive-sell'].includes(op.stage) || op.review?.genesisHash !== genesisHash || op.review.wallet !== walletRef.current || op.review.payer !== walletRef.current || op.review.requiredSigners?.length !== 1 || op.review.requiredSigners[0] !== walletRef.current) throw Error('Trade identity or wallet changed. Signing has been stopped.')
    setOperation(op); setBlockers([]); setAccepted(false); setUncertain(false); return true
  }
  async function run(action) {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause.message || 'Trade interrupted. Refresh its original signing ID.'); setUncertain(!!operation || !!id); setAccepted(false) }
    finally { running.current = false; setBusy(false) }
  }
  const action = name => run(async () => {
    if (!authenticated || !uuid(id)) throw Error('Authenticate your wallet and enter the original signing ID.')
    retain(id)
    if (name === 'submit') setUncertain(true)
    receive(await call({ action: name, signingId: id }))
  })
  useEffect(() => {
    if (!authenticated || !operation || !pending.has(operation.status)) return
    const timer = setInterval(() => action('reconcile'), 8000)
    return () => clearInterval(timer)
  }, [authenticated, operation?.id, operation?.status])
  const startSeparateTrade = () => run(async () => {
    if (!authenticated || operation?.status !== 'finalized-success' || operation.settlement?.evidenceConflict) throw Error('The original trade must be finalized before starting a separate trade.')
    localStorage.setItem(storageKey+'.last-completed',id); localStorage.removeItem(storageKey);setCompletedId(id);setId('');setOperation(null);setAccepted(false);setUncertain(false)
    setForm({...form,amountIn:'',minAmountOut:'',maxInput:''})
  })
  const getQuote = () => run(async () => {
    if (!authenticated) throw Error('Connect and authenticate the same wallet first.')
    for (const key of ['mint', 'selectedConfig']) if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(form[key])) throw Error(`Enter the exact ${key} address.`)
    for (const key of ['amountIn', 'minAmountOut', 'maxInput']) if (!/^[1-9][0-9]{0,19}$/.test(form[key])) throw Error(`${key} must be a positive integer amount in base units.`)
    for (const key of ['capBps', 'creatorFeeBps', 'maxPriceImpactBps']) if (!/^\d{1,4}$/.test(form[key])) throw Error(`Enter ${key} explicitly in basis points.`)
    if (+form.capBps < 1 || +form.capBps > 9999) throw Error('Wallet cap must be 1–9999 basis points.')
    if (BigInt(form.amountIn) > BigInt(form.maxInput)) throw Error('Maximum input must cover the requested input.')
    const signingId = id || crypto.randomUUID(); retain(signingId)
    const request = { ...form, capBps: +form.capBps, creatorFeeBps: +form.creatorFeeBps, maxPriceImpactBps: +form.maxPriceImpactBps }
    receive(await call({ action: 'quote', signingId, request }), signingId)
  })
  const sign = () => run(async () => {
    if (!canAct || !accepted || expired || operation.status !== 'reviewed') throw Error('Review and accept the current exact quote first.')
    const address = walletRef.current, reviewed = operation.review
    const value = await call({ action: 'wallet-request', signingId: id })
    if (value.status === 'blocked') { setBlockers(value.blockers || []); setAccepted(false); return }
    if (value.review?.wallet !== address || value.review.genesisHash !== genesisHash || value.review.messageSha256 !== reviewed.messageSha256) throw Error('The transaction differs from your review. Signing was stopped.')
    const { VersionedTransaction } = await import('@solana/web3.js')
    const tx = VersionedTransaction.deserialize(decode(value.partialTransactionBase64)), message = Uint8Array.from(tx.message.serialize())
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', message))].map(value => value.toString(16).padStart(2, '0')).join('')
    if (encode(message) !== value.review.messageBase64 || digest !== reviewed.messageSha256 || walletRef.current !== address || Date.now() >= reviewed.reviewExpiresAtMs) throw Error('Transaction identity, wallet or validity changed.')
    const adapter = provider()
    if (typeof adapter?.signTransaction !== 'function') throw Error('Connect a wallet that supports transaction signing.')
    const signed = await adapter.signTransaction(tx)
    if (walletRef.current !== address || !equal(signed.message.serialize(), message) || signed.signatures.length !== 1 || !signed.signatures[0].some(value => value !== 0)) throw Error('Wallet changed the transaction or returned no signature. Submission was stopped.')
    receive(await call({ action: 'retain-wallet', signingId: id, signedTransactionBase64: encode(signed.serialize()) }))
  })
  return <div style={{ overflowWrap: 'anywhere' }}>
    {!wallet && <button disabled={busy} onClick={() => run(() => connect())}>Connect wallet</button>}
    <HookWalletSignIn genesisHash={genesisHash} onIdentity={setIdentity}/>
    {blockers.length > 0 && <section className="hooks-notice" role="status"><div><h2>Trading unavailable</h2><ul>{blockers.map(item => <li key={item.code}>{item.message} ({item.code})</li>)}</ul></div></section>}
    <section className="inner-card"><h2>Buy or sell</h2><p>Enter exact native-asset amounts in base units. A buy spends native quote and receives coin; a sell spends coin and receives native quote. This flow does not convert wallet SOL to bridged native quote. Minimum received is enforced on-chain. The impact ceiling is checked during review but is not a separate on-chain limit; actual impact can change before execution.</p>
      <label>Side <select value={form.side} disabled={busy || !!operation} onChange={event => setForm({ ...form, side: event.target.value })}><option value="buy">Buy coin</option><option value="sell">Sell coin</option></select></label>
      {Object.entries({ mint: 'Coin mint', selectedConfig: 'Selected configuration address', capBps: 'Max-wallet cap (basis points)', creatorFeeBps: 'Creator fee (basis points)', amountIn: 'Exact input (base units)', minAmountOut: 'Minimum received (base units)', maxInput: 'Maximum input authorized (base units)', maxPriceImpactBps: 'Review-only impact ceiling (basis points)' }).map(([key, label]) => <label key={key} style={{ display: 'block', marginBottom: 12 }}>{label}<input style={{ display: 'block', width: '100%' }} value={form[key]} disabled={busy || !!operation} inputMode={['mint', 'selectedConfig'].includes(key) ? undefined : 'numeric'} onChange={event => setForm({ ...form, [key]: event.target.value })}/></label>)}
      <button disabled={!authenticated || busy || uncertain || !!operation || blockers.length > 0} onClick={getQuote}>{busy ? 'Working…' : 'Get exact verified quote'}</button>
    </section>
    <section className="inner-card"><h2>Resume a trade</h2><p>Keep this signing ID. Refresh the original trade after an interrupted action; never replace an uncertain trade.</p><label>Signing ID<input style={{ width: '100%' }} value={id} disabled={busy || !!operation} onChange={event => setId(event.target.value)}/></label><button disabled={!authenticated || busy || !uuid(id)} onClick={() => action('get')}>Refresh / resume original trade</button></section>
    {completedId && <p>Last completed trade signing ID: {completedId}. Its receipt remains retained on the server.</p>}{error && <p role="alert">{error}</p>}{uncertain && <p role="alert">An action needs a status refresh. Signing and submission are paused.</p>}
    {operation && <section className="inner-card" aria-live="polite"><h2>{operation.stage === 'inclusive-buy' ? 'Buy' : 'Sell'} review</h2><p>Retained status: {operation.status}. Signing ID: {operation.id}</p>
      {verifiedQuote ? <dl>
        <dt>Mint / configuration</dt><dd>{intent.mint} / {intent.selectedConfig}</dd><dt>Max-wallet cap</dt><dd>{intent.capBps} basis points</dd>
        <dt>Exact input</dt><dd>{intent.amountIn} base units</dd><dt>Maximum input</dt><dd>{intent.maxInput} base units</dd><dt>Expected received</dt><dd>{quote.delivered} base units</dd><dt>Minimum received</dt><dd>{quote.minAmountOut} base units</dd><dt>Quoted price impact</dt><dd>{quote.priceImpactBps} basis points</dd><dt>Review-only impact ceiling</dt><dd>{intent.maxPriceImpactBps} basis points</dd><dt>Wallet cap amount</dt><dd>{quote.capRaw} coin base units</dd>
        <dt>Creator fee rate</dt><dd>{quote.creatorFeeBps} basis points</dd><dt>Total collected creator fee</dt><dd>{quote.grossCreatorFee} quote base units</dd><dt>Platform share of that fee</dt><dd>{quote.protocolFee} quote base units (25%, rounded down)</dd><dt>Creator receives</dt><dd>{quote.netCreatorFee} quote base units (remainder)</dd><dt>Platform collector</dt><dd>{quote.platformCollector}</dd>
      </dl> : <p role="alert">Verified inclusive-fee economics are missing. Signing and submission are unavailable.</p>}
      <dl><dt>Wallet / payer</dt><dd>{review.wallet} / {review.payer}</dd><dt>Network genesis</dt><dd>{review.genesisHash}</dd><dt>Base network fee</dt><dd>{review.baseFeeLamports} lamports</dd><dt>Maximum network fee</dt><dd>{review.maxFeeLamports} lamports</dd><dt>Instruction debit</dt><dd>{review.instructionDebitLamports} lamports</dd><dt>Total native debit cap</dt><dd>{review.maxNativeDebitLamports} lamports</dd><dt>Review expires</dt><dd>{new Date(review.reviewExpiresAtMs).toISOString()}</dd><dt>Exact message SHA-256</dt><dd>{review.messageSha256}</dd></dl>
      <details><summary>Exact server quote, accounts and deployment pins</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ request: intent, accounts: review.accounts, profileSha256: review.profileSha256, configurationSha256: operation.configurationSha256, intentSha256: review.intentSha256 }, null, 2)}</pre></details>
      {operation.status === 'reviewed' && expired && !operation.walletRequestIssued && <><p>This unsigned review expired. Refreshing preserves the trade intent and requires a new review.</p><button disabled={!authenticated || busy || uncertain} onClick={() => action('refresh-review')}>Refresh unsigned review</button></>}
      {operation.status === 'reviewed' && !expired && <><label><input type="checkbox" checked={accepted} disabled={!canAct} onChange={event => setAccepted(event.target.checked)}/> I reviewed this exact input, minimum received, fees, cap and debit limit.</label><button disabled={!canAct || !accepted} onClick={sign}>Sign exact trade in wallet</button></>}
      {operation.status === 'reviewed' && expired && operation.walletRequestIssued && <p role="alert">This message was already issued to your wallet. Only original-message recovery is allowed; do not replace it with a fresh quote.</p>}
      {operation.status === 'signed' && <><button disabled={!canAct || expired} onClick={() => action('submit')}>Submit signed trade once</button>{expired && <p role="alert">Signed review expired. Operator recovery is required; do not create a replacement trade.</p>}</>}
      {pending.has(operation.status) && <><p>Checking the original transaction every 8 seconds while this page is open. Its final outcome is not yet established. Preserve this signing ID; do not resend or create a replacement trade to resolve it.</p><button disabled={!authenticated || busy} onClick={() => action('reconcile')}>Check original transaction now</button></>}
      {operation.signature && <p>Transaction receipt: <a target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${encodeURIComponent(operation.signature)}`}>{operation.signature}</a></p>}
      {operation.settlement?.executionStatus === 'finalized-executed' && <section aria-label="Actual finalized trade"><h3>Actual finalized execution</h3><dl>
        <dt>Actually received</dt><dd>{operation.settlement.quote?.delivered} base units</dd><dt>Actual price impact</dt><dd>{operation.settlement.quote?.priceImpactBps} basis points</dd>
        <dt>Actual total creator fee</dt><dd>{operation.settlement.quote?.grossCreatorFee} quote base units</dd><dt>Actual platform fee</dt><dd>{operation.settlement.quote?.protocolFee} quote base units</dd><dt>Actual creator remainder</dt><dd>{operation.settlement.quote?.netCreatorFee} quote base units</dd>
      </dl>{operation.settlement.policyReviewRequired && <p role="alert">This trade executed and finalized, but a review-only bound was exceeded. {operation.settlement.quote?.priceImpactReviewBoundExceeded && 'Actual price impact exceeded the reviewed ceiling. '}{operation.settlement.reviewSlotBoundExceeded && 'Execution occurred after the reviewed slot window, within the signed blockhash lifetime. '}The on-chain minimum received was satisfied. Review the difference before further trading; this is not a failed transaction and must not be resubmitted.</p>}</section>}
      {operation.status === 'finalized-success' && <><p>Trade executed and finalized. Keep the signing ID and receipt.</p><button disabled={!authenticated || busy || !!operation.settlement?.evidenceConflict} onClick={startSeparateTrade}>Start a separate trade</button></>}
      {['finalized-failure', 'review-required', 'signing-unknown', 'signing-claimed', 'partial'].includes(operation.status) && <p role="alert">The retained trade needs review or recovery. No replacement, signing or repeat submission is offered.</p>}
    </section>}
  </div>
}
