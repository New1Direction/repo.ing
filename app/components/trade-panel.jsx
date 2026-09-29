'use client'
import { loadTradePreview } from '../lib/trade-preview.mjs'
import { BuyPresets } from './buy-presets'
import { LoadingSignal } from './loading-signal'
import { TradeSizeGuide } from './trade-size-guide'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { useEffect, useRef, useState } from 'react'
import bs58 from 'bs58'
import { useRouter } from 'next/navigation'
import { useWallet } from './wallet'
import { TransactionStatus } from './ui'
import { TradeResultCard } from './trade-result-card'
import { formatSolDisplay, formatUnits, parseUnits, formatUsdEstimate } from '../lib/format.mjs'
import { sellAmountForPercent, tokenBalanceLabel } from '../lib/token-balance.mjs'
import { sameAmount } from '../lib/quick-amounts.mjs'

async function fetchSolBalance(wallet, signal) {
  const response = await fetch(`/api/wallet/balance?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store', signal })
  if (!response.ok) throw new Error('SOL balance unavailable')
  const result = await response.json()
  if (!/^\d+$/.test(result.lamports)) throw new Error('Invalid SOL balance')
  return result.lamports
}

async function fetchTokenBalance(wallet, mint, signal) {
  const response = await fetch(`/api/market/${encodeURIComponent(mint)}/balance?wallet=${encodeURIComponent(wallet)}`,
    { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Wallet balance unavailable')
  const result = await response.json()
  if (!/^\d+$/.test(result.balanceBaseUnits) || result.decimals !== 6) throw new Error('Invalid wallet balance')
  return result.balanceBaseUnits
}

async function fetchTradeStatus(result) {
  const response = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'status', id: result.id, signature: result.signature,
      lastValidBlockHeight: result.lastValidBlockHeight }), cache: 'no-store' })
  const status = await response.json()
  if (!response.ok) throw new Error(status.error || 'Trade status unavailable')
  return status
}

export function TradePanel({ market, available, usdPerSol = null, curve = null }) {
  const [direction, setDirection] = useState('buy')
  const panelRef = useRef(null)
  const [panelVisible, setPanelVisible] = useState(false)
  const [amount, setAmount] = useState('')
  const [minimumOut, setMinimumOut] = useState(null)
  const [preparedCosts, setPreparedCosts] = useState(null)
  const [liveQuote, setLiveQuote] = useState(null)
  const [costPreview, setCostPreview] = useState(null)
  const quoteRef = useRef(null)
  quoteRef.current = liveQuote
  const [quoteStatus, setQuoteStatus] = useState('')
  const [quoteRefresh, setQuoteRefresh] = useState(0)
  const submitting = useRef(false)
  const [stage, setStage] = useState('')
  const [resultCard, setResultCard] = useState(null)
  const [busy, setBusy] = useState(false)
  const [balance, setBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceError, setBalanceError] = useState(false)
  const [balanceRefresh, setBalanceRefresh] = useState(0)
  const [solBalance, setSolBalance] = useState(null)
  const [solBalanceLoading, setSolBalanceLoading] = useState(false)
  const [solBalanceError, setSolBalanceError] = useState(false)
  const { wallet, connect, provider } = useWallet()
  const router = useRouter()
  const lastChartRefreshSignature = useRef(null)
  // A graduated market trades in its verified DAMM pool; migration without a verified destination stays closed.
  const graduatedPool = curve?.status === 'graduated' ? curve.destination ?? null : null
  const tradingOpen = !curve || curve.status === 'active' || Boolean(graduatedPool)

  useEffect(() => {
    if (!panelRef.current || !window.IntersectionObserver) return
    const observer = new IntersectionObserver(([entry]) => setPanelVisible(entry.isIntersecting), { threshold: 0.1 })
    observer.observe(panelRef.current)
    return () => observer.disconnect()
  }, [tradingOpen])

  function openTrade(next) {
    if (busy) return
    if (next !== direction) selectDirection(next)
    panelRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
    panelRef.current?.focus({ preventScroll: true })
  }

  function applyTradeStatus(status, original) {
    setResultCard(current => {
      if (current?.signature !== original.signature) return current
      if ((current.state === 'confirmed' && status.state !== 'confirmed') ||
          (current.state === 'chainConfirmed' && status.state !== 'confirmed')) return current
      return { ...current, ...status }
    })
    if (status.state === 'confirmed' || status.state === 'chainConfirmed') {
      setAmount('')
      setMinimumOut(null)
      setLiveQuote(null)
      setBalanceRefresh(value => value + 1)
      router.refresh()
      if (lastChartRefreshSignature.current !== original.signature) {
        lastChartRefreshSignature.current = original.signature
        window.dispatchEvent(new CustomEvent('repoing:trade-confirmed', {
          detail: { mint: market.mint, signature: original.signature },
        }))
      }
    }
  }

  async function checkTrade(result) {
    try { applyTradeStatus(await fetchTradeStatus(result), result) }
    catch { /* Keep the signed transaction visible until status can be read. */ }
  }

  useEffect(() => {
    if (resultCard?.state !== 'pending') return
    let active = true
    let timer
    let checks = 0
    async function poll() {
      try {
        const status = await fetchTradeStatus(resultCard)
        if (!active) return
        if (status.state !== 'pending') { applyTradeStatus(status, resultCard); return }
      } catch { /* A temporary RPC error must not turn a signed trade into a failure. */ }
      if (active && ++checks < 20) timer = window.setTimeout(poll, 3000)
    }
    timer = window.setTimeout(poll, 3000)
    return () => { active = false; window.clearTimeout(timer) }
  }, [resultCard?.state, resultCard?.signature, resultCard?.id, resultCard?.lastValidBlockHeight])

  useEffect(() => {
    if (!amount || busy) return
    return visiblePolling(() => setQuoteRefresh(value => value + 1), 15000)
  }, [amount, busy])

  useEffect(() => {
    if (!liveQuote) return
    const timer = window.setTimeout(() => {
      setLiveQuote(null)
      setQuoteStatus('Quote expired. Please refresh.')
    }, Math.max(0, liveQuote.receivedAt + 30000 - Date.now()))
    return () => window.clearTimeout(timer)
  }, [liveQuote])

  useEffect(() => {
    setQuoteStatus('')
    setCostPreview(null)
    if (!busy) setPreparedCosts(null)
    if (!available || !tradingOpen || !amount || busy) { setLiveQuote(null); return }
    let input
    try { input = parseUnits(amount, direction === 'buy' ? 9 : 6) } catch (error) { setLiveQuote(null); setQuoteStatus(error.message); return }
    if (direction === 'sell' && balance !== null && BigInt(input) > BigInt(balance)) {
      setLiveQuote(null)
      setQuoteStatus('Amount exceeds your token balance')
      return
    }
    const controller = new AbortController()
    const inputKey = `${market.repoId}:${direction}:${input}:${wallet ?? ""}`
    const keepEstimate = quoteRef.current?.inputKey === inputKey && Date.now() - quoteRef.current.receivedAt < 30000
    if (!keepEstimate) setLiveQuote(null)
    setQuoteStatus(keepEstimate ? 'Refreshing quote…' : 'Calculating quote…')
    if (wallet) setCostPreview({ inputKey, loading: true })
    const timer = window.setTimeout(() => {
      void loadTradePreview({
        request: { githubRepoId: market.repoId, direction, wallet, amountBaseUnits: input },
        signal: controller.signal,
        onQuote: result => { setLiveQuote({ ...result, inputKey, receivedAt: Date.now() }); setQuoteStatus('') },
        onQuoteError: cause => { setLiveQuote(null); setQuoteStatus(cause.name === 'TimeoutError' ? 'Quote timed out. Please retry.' : cause.message || 'Quote unavailable') },
        onCosts: result => setCostPreview({ ...result, inputKey }),
      })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [amount, available, balance, busy, direction, market.repoId, solBalance, tradingOpen, quoteRefresh, wallet])

  useEffect(() => {
    if (direction !== 'buy' || !wallet) {
      setSolBalance(null)
      setSolBalanceLoading(false)
      setSolBalanceError(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setSolBalance(null)
    setSolBalanceLoading(true)
    setSolBalanceError(false)
    async function refresh() {
      try {
        const lamports = await fetchSolBalance(wallet, controller.signal)
        if (active) { setSolBalance(lamports); setSolBalanceError(false); setSolBalanceLoading(false) }
      } catch { if (active) { setSolBalance(null); setSolBalanceError(true); setSolBalanceLoading(false) } }
    }
    const stopPolling = visiblePolling(refresh, 20000)
    return () => { active = false; controller.abort(); stopPolling() }
  }, [wallet, direction, balanceRefresh])

  useEffect(() => {
    if (direction !== 'sell' || !wallet) {
      setBalance(null)
      setBalanceLoading(false)
      setBalanceError(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setBalance(null)
    setBalanceLoading(true)
    setBalanceError(false)
    async function refresh() {
      try {
        const current = await fetchTokenBalance(wallet, market.mint, controller.signal)
        if (active) { setBalance(current); setBalanceError(false); setBalanceLoading(false) }
      } catch { if (active) { setBalance(null); setBalanceError(true); setBalanceLoading(false) } }
    }
    const stopPolling = visiblePolling(refresh, 20000)
    return () => { active = false; controller.abort(); stopPolling() }
  }, [wallet, direction, market.mint, balanceRefresh])

  function selectDirection(next) {
    setDirection(next)
    setAmount('')
    setMinimumOut(null)
    setLiveQuote(null)
    setStage('')
  }

  function selectPercent(percent) {
    if (balance === null) return
    const selected = sellAmountForPercent(balance, percent)
    if (selected) { setAmount(selected); setMinimumOut(null); setLiveQuote(null) }
  }

  async function submit(event) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true); setPreparedCosts(null); setResultCard(null); setMinimumOut(null); setLiveQuote(null)
    let signedTrade = null
    try {
      if (!available) throw new Error('Trading is unavailable until the canonical pool and local RPC are configured.')
      const address = wallet || await connect()
      const input = parseUnits(amount, direction === 'buy' ? 9 : 6)
      if (direction === 'buy') {
        setStage('Checking SOL balance')
        const currentSolBalance = await fetchSolBalance(address)
        // The exact prepared transaction checks input, network costs and rent together.
        setSolBalance(currentSolBalance)
      }
      if (direction === 'sell') {
        setStage('Checking token balance')
        const currentTokenBalance = await fetchTokenBalance(address, market.mint)
        if (BigInt(input) > BigInt(currentTokenBalance)) throw new Error('Amount exceeds your token balance')
        setBalance(currentTokenBalance)
      }
      setStage('Preparing quote')
      const preparedResponse = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'prepare', githubRepoId: market.repoId, wallet: address,
          direction, amountBaseUnits: input }) })
      const prepared = await preparedResponse.json()
      if (!preparedResponse.ok) throw new Error(prepared.error)
      setPreparedCosts(prepared.costs)
      setMinimumOut(prepared.minimumAmountOut)
      setStage('Waiting for wallet')
      const { Transaction } = await import('@solana/web3.js')
      const tx = Transaction.from(Uint8Array.from(atob(prepared.transaction), c => c.charCodeAt(0)))
      const signed = await provider().signTransaction(tx)
      if (!signed.signature) throw new Error('Wallet did not sign the transaction')
      signedTrade = { state: 'pending', direction, signature: bs58.encode(signed.signature),
        id: prepared.id, lastValidBlockHeight: prepared.lastValidBlockHeight }
      setResultCard(signedTrade)
      setStage('Checking transaction')
      const submittedResponse = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'submit', id: prepared.id, transaction: btoa(String.fromCharCode(...signed.serialize())) }) })
      const submitted = await submittedResponse.json()
      if (!submittedResponse.ok) throw new Error(submitted.error)
      applyTradeStatus(submitted, signedTrade)
    } catch (cause) {
      if (signedTrade) setResultCard(current => current?.signature === signedTrade.signature ? current : signedTrade)
      else setResultCard({ state: 'notSubmitted', direction, message: cause.message || 'Trade was not submitted' })
    } finally { submitting.current = false; setBusy(false); setPreparedCosts(null); setStage('') }
  }

  let validAmount = false, sellExceedsBalance = false
  try { const raw = BigInt(parseUnits(amount, direction === 'buy' ? 9 : 6)); validAmount = raw > 0n; sellExceedsBalance = direction === 'sell' && balance !== null && raw > BigInt(balance) } catch {}
  let buyExceedsBalance = false
  if (direction === 'buy' && amount && solBalance !== null) {
    try { buyExceedsBalance = BigInt(parseUnits(amount, 9)) >= BigInt(solBalance) } catch { /* The input validator handles malformed amounts. */ }
  }

  const currentCosts = liveQuote && costPreview?.inputKey === liveQuote.inputKey ? costPreview : null
  const costs = busy ? preparedCosts : currentCosts?.costs
  const costShortfall = costs && BigInt(costs.shortfall) > 0n
  let usdAmount = null
  try { usdAmount = formatUsdEstimate(direction === 'buy' && amount ? parseUnits(amount, 9) : liveQuote?.outputAmount, usdPerSol) } catch { /* Wait for a valid amount. */ }
  if (!tradingOpen && !busy && !resultCard) return <div className="trade-card graduated-trade"><h2>{curve.status === 'graduated' ? 'This market has graduated' : 'Migration in progress'}</h2><p>Bonding-curve trades have ended. We are checking the destination pool; trading resumes here once it is verified. This page updates automatically.</p></div>
  return <><div className="trade-card" id="trade-panel" ref={panelRef} tabIndex={-1} aria-label={`Trade ${market.symbol}`}>
    <div className="trade-tabs" role="tablist" aria-label="Trade direction">
      <button disabled={busy} role="tab" aria-selected={direction === 'buy'} className={direction === 'buy' ? 'selected' : ''} onClick={() => selectDirection('buy')}>Buy</button>
      <button disabled={busy} role="tab" aria-selected={direction === 'sell'} className={direction === 'sell' ? 'selected' : ''} onClick={() => selectDirection('sell')}>Sell</button>
    </div>
    {graduatedPool && <p className="trade-venue-note">Trading in the graduated Meteora pool. <a href={graduatedPool.url} target="_blank" rel="noopener noreferrer">View pool on Meteora ↗</a></p>}
    <form onSubmit={submit} aria-busy={busy}>
      <label htmlFor="trade-amount">You {direction === 'buy' ? 'pay' : 'sell'}</label>
      <div className="asset-input"><input id="trade-amount" disabled={busy} aria-describedby="trade-quote-hint" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={e => { setAmount(e.target.value); setMinimumOut(null); setLiveQuote(null) }} required/><span>{direction === 'buy' ? 'SOL' : market.symbol}</span></div>
      {direction === 'buy' && <div className="trade-balance-row">
        <span title={solBalance === null ? undefined : `${formatUnits(solBalance, 9)} SOL`}>
          {solBalanceLoading ? 'Loading SOL balance…' : solBalance !== null ? `Balance: ${formatSolDisplay(solBalance)} SOL` : solBalanceError ? 'SOL balance unavailable' : 'Connect wallet to see your SOL balance'}
        </span>
        {!wallet && <button type="button" onClick={() => connect().catch(() => {})}>Connect wallet</button>}
        {wallet && solBalanceError && <button type="button" onClick={() => setBalanceRefresh(value => value + 1)}>Retry</button>}
      </div>}
      {direction === 'buy' && (!curve || curve.status === 'active') && <TradeSizeGuide repoId={market.repoId} disabled={busy} onSelect={value => { setAmount(value); setLiveQuote(null); setMinimumOut(null) }}/>}
      {direction === 'buy' && <BuyPresets disabled={busy} amount={amount} solBalance={solBalance} onSelect={value => { setAmount(value); setLiveQuote(null); setMinimumOut(null) }}/>}
      {direction === 'sell' && <>
        <div className="trade-balance-row">
          <span title={balance === null ? undefined : `${formatUnits(balance, 6)} ${market.symbol}`}>
            {balanceLoading ? 'Loading balance…' : balance !== null ? `Balance: ${tokenBalanceLabel(balance)} ${market.symbol}` : balanceError ? 'Balance unavailable' : 'Connect wallet to see your balance'}
          </span>
          {!wallet && <button type="button" onClick={() => connect().catch(() => {})}>Connect wallet</button>}
          {wallet && balanceError && <button type="button" onClick={() => setBalanceRefresh(value => value + 1)}>Retry</button>}
        </div>
        <div className="trade-quick-actions" role="group" aria-label="Sell amount shortcuts">
          {[25, 50, 100].map(percent => { const preset = balance === null ? '' : sellAmountForPercent(balance, percent)
            return <button type="button" key={percent} disabled={busy || !preset} aria-pressed={!!preset && sameAmount(amount, preset, 6)}
              onClick={() => selectPercent(percent)} aria-label={`Sell ${percent}% of your token balance`}>{percent === 100 ? 'MAX' : `${percent}%`}</button> })}
        </div>
      </>}
      <div className="trade-convert">↓</div>
      <label>{minimumOut && !liveQuote ? 'Minimum receive' : 'Estimated receive'}</label>
      <div className={`asset-input read-only quote-output${(!liveQuote && quoteStatus) || !amount ? ' is-waiting' : ''}`} role="status" aria-live="polite" aria-busy={quoteStatus === 'Calculating quote…' || quoteStatus === 'Refreshing quote…'}><span>{quoteStatus === 'Calculating quote…' && <LoadingSignal/>}{liveQuote ? formatUnits(liveQuote.outputAmount, direction === 'buy' ? 6 : 9, 6) : minimumOut ? formatUnits(minimumOut, direction === 'buy' ? 6 : 9, 6) : quoteStatus || (amount ? '—' : 'Enter an amount')}{liveQuote && quoteStatus === 'Refreshing quote…' && <LoadingSignal/>}</span><span>{direction === 'buy' ? market.symbol : 'SOL'}</span></div>
      {quoteStatus && !['Calculating quote…', 'Refreshing quote…'].includes(quoteStatus) && validAmount && <button type="button" className="quote-retry" disabled={busy} onClick={() => setQuoteRefresh(value => value + 1)}>Retry quote</button>}
      <p className="trade-hint" id="trade-quote-hint">{liveQuote || minimumOut
        ? `Minimum after 1% slippage: ${formatUnits(minimumOut || liveQuote.minimumAmountOut, direction === 'buy' ? 6 : 9, 6)} ${direction === 'buy' ? market.symbol : 'SOL'}. Refreshed before wallet confirmation.`
        : 'Quote updates as you enter an amount. Fixed slippage: 1%.'}{direction === 'buy' && ' Leave SOL for network fees and token-account costs.'}</p>
      {(usdAmount || liveQuote) && <dl className="trade-quote-details">{usdAmount && <div><dt>{direction === 'buy' ? 'Estimated spend' : 'Estimated receive'}</dt><dd>≈ {usdAmount}</dd></div>}{liveQuote && <><div><dt>Trading fee <small>(included)</small></dt><dd>{formatSolDisplay(liveQuote.tradingFeeLamports)} SOL</dd></div><div><dt title="Difference between the fee-excluded execution price and current pool spot price">Price impact</dt><dd>{Number.isFinite(liveQuote.priceImpactPercent) ? `${liveQuote.priceImpactPercent.toFixed(2)}%` : '—'}</dd></div></>}</dl>}
      {(liveQuote || preparedCosts) && <div className="trade-cost-preview">
        {costs ? <><dl className="trade-quote-details"><div><dt>Network fee</dt><dd>≈ {formatUnits(costs.networkFee)} SOL</dd></div><div><dt>Token account deposit</dt><dd>{formatUnits(costs.accountDeposits)} SOL</dd></div>{BigInt(costs.refundableDeposit) > 0n && <div><dt>Temporary deposit <small>(returned)</small></dt><dd>{formatUnits(costs.refundableDeposit)} SOL</dd></div>}<div className="trade-cost-total"><dt>{direction === 'buy' ? 'Total spend' : 'SOL costs'}</dt><dd>≈ {formatUnits(costs.total)} SOL</dd></div></dl><p className="trade-hint">{BigInt(costs.refundableDeposit) > 0n ? `${formatUnits(costs.required)} SOL needed up front; the temporary deposit returns in this transaction. ` : ''}Estimate checked again before signing.</p></> : <p className="trade-hint">{wallet ? currentCosts?.loading ? 'Checking network fees and account deposits…' : 'Network cost estimate unavailable. Checked again before wallet approval.' : 'Connect your wallet to preview network fees and account deposits.'}</p>}
        {costShortfall && <p className="trade-funding-note" role="status">You need ≈ {formatUnits((BigInt(costs.shortfall) + 999n) / 1000n * 1000n)} more SOL to cover this trade.</p>}
      </div>}
      {liveQuote?.priceImpactPercent >= 5 && <p className="trade-impact-warning" role="status">High price impact. This trade moves the execution price by about {liveQuote.priceImpactPercent.toFixed(2)}% before fees. Consider a smaller amount.</p>}
      <button className="button primary trade-submit" type="submit" disabled={busy || !available || !tradingOpen || !validAmount || buyExceedsBalance || costShortfall || sellExceedsBalance || resultCard?.state === 'pending'}>{busy && <LoadingSignal/>}{busy ? stage || 'Preparing…' : `${direction === 'buy' ? 'Buy' : 'Sell'} ${market.symbol}`}</button>
      <TransactionStatus stage={busy ? stage : ''}/>
    </form>
    <TradeResultCard result={resultCard} symbol={market.symbol} mint={market.mint} fullName={market.fullName} onClose={() => setResultCard(null)} onCheck={() => checkTrade(resultCard)}/>
  </div>{!panelVisible && !resultCard && <nav className="mobile-trade-actions" aria-label="Quick trade navigation"><span>${market.symbol}</span><button type="button" className="button primary" disabled={busy || !available} onClick={() => openTrade('buy')}>Buy</button><button type="button" className="button outline" disabled={busy || !available} onClick={() => openTrade('sell')}>Sell</button></nav>}</>
}
