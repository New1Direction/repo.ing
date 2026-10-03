'use client'
import { loadTradePreview } from '../lib/trade-preview.mjs'
import { BuyPresets } from './buy-presets'
import { LoadingSignal } from './loading-signal'
import { TradeSizeGuide } from './trade-size-guide'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import bs58 from 'bs58'
import { useRouter } from 'next/navigation'
import { useWallet } from './wallet'
import { TransactionStatus } from './ui'
import { TradeResultCard } from './trade-result-card'
import { formatSolDisplay, formatUnits, parseUnits, formatUsdEstimate } from '../lib/format.mjs'
import { sellAmountForPercent, tokenBalanceLabel } from '../lib/token-balance.mjs'
import { sameAmount } from '../lib/quick-amounts.mjs'
import { captureReferral, storedReferral } from '../lib/referral.mjs'
import { feePercentLabel, launchFeeTradeNote } from '../../src/launch-fee-copy.mjs'
import { DEFAULT_SLIPPAGE_BPS, parseSlippageBps, SLIPPAGE_EXCEEDED, slippageLabel } from '../../src/trade-slippage.mjs'
import { SlippageSetting } from './slippage-setting'
import { ArrowDown } from 'lucide-react'
import { useXLink } from './x-link-state'
import { hasXHandle } from './x-handle-link'
import { TradeIdentity } from './trade-identity'
import { quoteAmountLabel, tradeButtonLabel } from '../lib/trade-panel.mjs'
import { SOL_UNITS, parseShownAmount, shownPercentAmount, shownShortfall, shownUnits, stockUnits, stockUsdLabel } from '../lib/trade-units.mjs'
import '../trade-panel.css'

const SLIPPAGE_KEY = 'repoing:slippage-bps'
function localStore() { try { return window.localStorage } catch { return null } }
// This browser's last chosen max slippage, or the 1% default.
function savedSlippage() {
  try { return parseSlippageBps(Number(localStore()?.getItem(SLIPPAGE_KEY))) } catch { return DEFAULT_SLIPPAGE_BPS }
}

async function fetchSolBalance(wallet, signal) {
  const response = await fetch(`/api/wallet/balance?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store', signal })
  if (!response.ok) throw new Error('SOL balance unavailable')
  const result = await response.json()
  if (!/^\d+$/.test(result.lamports)) throw new Error('Invalid SOL balance')
  return result.lamports
}

// A stock pair's buys spend its stock (docs/STOCK_QUOTES.md): the wallet's balance of it, raw units.
async function fetchStockBalance(wallet, assetId, signal) {
  const response = await fetch(`/api/wallet/balance?wallet=${encodeURIComponent(wallet)}&asset=${encodeURIComponent(assetId)}`,
    { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Balance unavailable')
  const result = await response.json()
  if (result.assetId !== assetId || !/^\d+$/.test(result.balanceBaseUnits)) throw new Error('Invalid balance')
  return result.balanceBaseUnits
}

// What a buy spends: SOL, or a stock pair's stock.
const fetchPayBalance = (wallet, quote, signal) => quote ? fetchStockBalance(wallet, quote.assetId, signal) : fetchSolBalance(wallet, signal)

// A stock pair's display facts: the multiplier wallets show it with and its USD price (app/api/quote-assets).
async function fetchStockInfo(quote, signal) {
  const response = await fetch(`/api/quote-assets/${encodeURIComponent(quote.assetId)}`, { signal })
  if (!response.ok) throw new Error('Pair details unavailable')
  const info = await response.json()
  if (info.assetId !== quote.assetId || info.decimals !== quote.decimals || !stockUnits(info)) throw new Error('Invalid pair details')
  return info
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

// The pay field's balance of what the trade spends, or the way to see it.
function TradeBalance({ wallet, loading, error, label, exact, onConnect, onRetry }) {
  if (!wallet) return <button type="button" className="trade-field-action" onClick={onConnect}>Connect wallet</button>
  if (loading) return <span className="trade-balance">Loading balance…</span>
  if (error) return <span className="trade-balance">Balance unavailable <button type="button" className="trade-field-action" onClick={onRetry}>Retry</button></span>
  return label ? <span className="trade-balance" title={exact}>Balance <strong>{label}</strong></span> : null
}

// 25% / 50% / MAX of a balance: sells of the market token, and buys of a stock pair, spent from the wallet's stock.
function PercentAmounts({ disabled, amount, decimals, label, preset, describe, onSelect }) {
  return <div className="trade-quick-actions" role="group" aria-label={label}>
    {[25, 50, 100].map(percent => { const value = preset(percent)
      return <button type="button" key={percent} disabled={disabled || !value} aria-pressed={!!value && sameAmount(amount, value, decimals)}
        onClick={() => { if (value) onSelect(value) }} aria-label={describe(percent)}>{percent === 100 ? 'MAX' : `${percent}%`}</button> })}
  </div>
}

// quote: the market's pair (src/quote-assets.mjs marketQuoteView): null for SOL, else the stock it is bought with and sold for.
export function TradePanel({ market, available, usdPerSol = null, curve = null, quote = null }) {
  const [direction, setDirection] = useState('buy')
  const panelRef = useRef(null)
  const [panelVisible, setPanelVisible] = useState(false)
  const [amount, setAmount] = useState('')
  const [minimumOut, setMinimumOut] = useState(null)
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [preparedSlippage, setPreparedSlippage] = useState(null)
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
  // What a buy spends: SOL, or a stock pair's stock.
  const [payBalance, setPayBalance] = useState(null)
  const [payBalanceLoading, setPayBalanceLoading] = useState(false)
  const [payBalanceError, setPayBalanceError] = useState(false)
  // A stock pair (docs/STOCK_QUOTES.md) shows its stock as wallets show it; until those units load the panel takes no amount.
  const stock = Boolean(quote)
  const [stockInfo, setStockInfo] = useState(null)
  const [stockInfoError, setStockInfoError] = useState(false)
  const [stockInfoRefresh, setStockInfoRefresh] = useState(0)
  const units = useMemo(() => stock ? stockUnits(stockInfo) : SOL_UNITS, [stock, stockInfo])
  const { wallet, connect, provider } = useWallet()
  // The wallet's linked X account: the trade shows as that @handle in the market's trades.
  const x = useXLink(wallet)
  const router = useRouter()
  const lastChartRefreshSignature = useRef(null)
  // A graduated market trades in its verified DAMM pool; migration without a verified destination stays closed. A graduated
  // stock pair stays closed too: its pool is not traded here yet (src/canonical-damm-trade.mjs refuses it).
  const graduatedPool = curve?.status === 'graduated' && !stock ? curve.destination ?? null : null
  const tradingOpen = !curve || curve.status === 'active' || Boolean(graduatedPool)

  useEffect(() => { const store = localStore(); if (store) captureReferral(window.location.search, store) }, [])
  useEffect(() => setSlippageBps(savedSlippage()), [])

  useEffect(() => {
    if (!quote || quote.unavailable) return
    let active = true
    const controller = new AbortController()
    async function refresh() {
      // A failed refresh keeps the last good units; it shows only while none have loaded.
      try { const info = await fetchStockInfo(quote, controller.signal); if (active) { setStockInfo(info); setStockInfoError(false) } }
      catch { if (active) setStockInfoError(true) }
    }
    const stopPolling = visiblePolling(refresh, 60000)
    return () => { active = false; controller.abort(); stopPolling() }
  }, [quote?.assetId, quote?.decimals, quote?.unavailable, stockInfoRefresh])

  function chooseSlippage(bps) {
    setSlippageBps(bps)
    setMinimumOut(null)
    try { localStore()?.setItem(SLIPPAGE_KEY, String(bps)) } catch { /* Keep the choice for this visit. */ }
  }

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
    if (!available || !tradingOpen || !amount || busy || !units) { setLiveQuote(null); return }
    let input
    try { input = direction === 'buy' ? parseShownAmount(amount, units) : parseUnits(amount, 6) } catch (error) { setLiveQuote(null); setQuoteStatus(error.message); return }
    if (direction === 'sell' && balance !== null && BigInt(input) > BigInt(balance)) {
      setLiveQuote(null)
      setQuoteStatus('Amount exceeds your token balance')
      return
    }
    const controller = new AbortController()
    const inputKey = `${market.repoId}:${direction}:${input}:${wallet ?? ""}:${slippageBps}`
    const keepEstimate = quoteRef.current?.inputKey === inputKey && Date.now() - quoteRef.current.receivedAt < 30000
    if (!keepEstimate) setLiveQuote(null)
    setQuoteStatus(keepEstimate ? 'Refreshing quote…' : 'Calculating quote…')
    if (wallet) setCostPreview({ inputKey, loading: true })
    const timer = window.setTimeout(() => {
      void loadTradePreview({
        request: { githubRepoId: market.repoId, direction, wallet, amountBaseUnits: input, slippageBps },
        signal: controller.signal,
        onQuote: result => { setLiveQuote({ ...result, inputKey, receivedAt: Date.now() }); setQuoteStatus('') },
        onQuoteError: cause => { setLiveQuote(null); setQuoteStatus(cause.name === 'TimeoutError' ? 'Quote timed out. Please retry.' : cause.message || 'Quote unavailable') },
        onCosts: result => setCostPreview({ ...result, inputKey }),
      })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [amount, available, balance, busy, direction, market.repoId, payBalance, tradingOpen, quoteRefresh, wallet, slippageBps, units])

  useEffect(() => {
    if (direction !== 'buy' || !wallet || quote?.unavailable) {
      setPayBalance(null)
      setPayBalanceLoading(false)
      setPayBalanceError(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setPayBalance(null)
    setPayBalanceLoading(true)
    setPayBalanceError(false)
    async function refresh() {
      try {
        const current = await fetchPayBalance(wallet, quote, controller.signal)
        if (active) { setPayBalance(current); setPayBalanceError(false); setPayBalanceLoading(false) }
      } catch { if (active) { setPayBalance(null); setPayBalanceError(true); setPayBalanceLoading(false) } }
    }
    const stopPolling = visiblePolling(refresh, 20000)
    return () => { active = false; controller.abort(); stopPolling() }
  }, [wallet, direction, balanceRefresh, quote?.assetId, quote?.unavailable])

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

  function chooseAmount(value) {
    setAmount(value)
    setLiveQuote(null)
    setMinimumOut(null)
  }

  function submit(event) {
    event.preventDefault()
    void trade(slippageBps, direction, amount)
  }

  // One tap after a slippage failure: the same trade again at the next preset. Only that trade is looser; the saved
  // setting stays what the trader chose.
  function retryWithSlippage(next) {
    const failed = resultCard
    if (!failed?.amount || busy) return
    setDirection(failed.direction)
    setAmount(failed.amount)
    void trade(next, failed.direction, failed.amount)
  }

  async function trade(tolerance, side, value) {
    if (submitting.current) return
    submitting.current = true
    setBusy(true); setPreparedCosts(null); setResultCard(null); setMinimumOut(null); setLiveQuote(null); setPreparedSlippage(null)
    let signedTrade = null
    try {
      if (!available) throw new Error('Trading is unavailable until the canonical pool and local RPC are configured.')
      if (!units) throw new Error(`${quote?.symbol ?? 'Pair'} details are still loading. Try again in a moment.`)
      const address = wallet || await connect()
      const input = side === 'buy' ? parseShownAmount(value, units) : parseUnits(value, 6)
      if (side === 'buy') {
        setStage(`Checking ${units.symbol} balance`)
        const currentPayBalance = await fetchPayBalance(address, quote)
        // The exact prepared transaction checks input, network costs and rent together. A stock buy spends only the stock.
        if (stock && BigInt(input) > BigInt(currentPayBalance)) throw new Error(`Amount exceeds your ${units.symbol} balance`)
        setPayBalance(currentPayBalance)
      }
      if (side === 'sell') {
        setStage('Checking token balance')
        const currentTokenBalance = await fetchTokenBalance(address, market.mint)
        if (BigInt(input) > BigInt(currentTokenBalance)) throw new Error('Amount exceeds your token balance')
        setBalance(currentTokenBalance)
      }
      setStage('Preparing quote')
      const preparedResponse = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'prepare', githubRepoId: market.repoId, wallet: address, direction: side, amountBaseUnits: input,
          slippageBps: tolerance, referrer: localStore() ? storedReferral(localStore(), address) : null }) })
      const prepared = await preparedResponse.json()
      if (!preparedResponse.ok) throw new Error(prepared.error)
      setPreparedCosts(prepared.costs)
      setMinimumOut(prepared.minimumAmountOut)
      setPreparedSlippage(prepared.slippageBps)
      setStage('Waiting for wallet')
      const { Transaction } = await import('@solana/web3.js')
      const tx = Transaction.from(Uint8Array.from(atob(prepared.transaction), c => c.charCodeAt(0)))
      const signed = await provider().signTransaction(tx)
      if (!signed.signature) throw new Error('Wallet did not sign the transaction')
      signedTrade = { state: 'pending', direction: side, amount: value, slippageBps: prepared.slippageBps, signature: bs58.encode(signed.signature),
        id: prepared.id, lastValidBlockHeight: prepared.lastValidBlockHeight }
      setResultCard(signedTrade)
      setStage('Checking transaction')
      const submittedResponse = await fetch('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'submit', id: prepared.id, transaction: btoa(String.fromCharCode(...signed.serialize())) }) })
      const submitted = await submittedResponse.json()
      // The server never broadcast it (its trade window closed, or the price was already past the minimum): show it as not
      // submitted; the next attempt re-prepares.
      if (submitted.code === 'TRADE_WINDOW_CLOSED' || submitted.code === SLIPPAGE_EXCEEDED) signedTrade = null
      if (!submittedResponse.ok) throw Object.assign(new Error(submitted.error),
        submitted.code === SLIPPAGE_EXCEEDED ? { reason: 'slippage', slippageBps: submitted.slippageBps } : {})
      applyTradeStatus(submitted, signedTrade)
    } catch (cause) {
      if (signedTrade) setResultCard(current => current?.signature === signedTrade.signature ? current : signedTrade)
      else setResultCard({ state: 'notSubmitted', direction: side, amount: value, message: cause.message || 'Trade was not submitted',
        reason: cause.reason, slippageBps: cause.slippageBps })
    } finally { submitting.current = false; setBusy(false); setPreparedCosts(null); setStage('') }
  }

  let inputRaw = null
  try { if (units) inputRaw = BigInt(direction === 'buy' ? parseShownAmount(amount, units) : parseUnits(amount, 6)) } catch { /* The input validator handles malformed amounts. */ }
  const validAmount = inputRaw !== null && inputRaw > 0n
  const sellExceedsBalance = direction === 'sell' && validAmount && balance !== null && inputRaw > BigInt(balance)
  // A SOL buy must leave SOL for fees and deposits; a stock buy spends only the stock, and SOL pays its costs separately.
  const buyExceedsBalance = direction === 'buy' && validAmount && payBalance !== null &&
    (stock ? inputRaw > BigInt(payBalance) : inputRaw >= BigInt(payBalance))

  // Only markets on a launch-fee config return launchFee; it is active during their first minutes.
  const launchFeeNote = liveQuote ? launchFeeTradeNote(liveQuote.launchFee) : null
  // The tolerance behind the minimum on screen: the live quote's, else the prepared trade's, else the setting.
  const shownSlippage = (liveQuote ? liveQuote.slippageBps : minimumOut ? preparedSlippage : null) ?? slippageBps
  const currentCosts = liveQuote && costPreview?.inputKey === liveQuote.inputKey ? costPreview : null
  const costs = busy ? preparedCosts : currentCosts?.costs
  const costShortfall = costs && BigInt(costs.shortfall) > 0n
  const quoteShortfall = stock && costs && BigInt(costs.quoteShortfall ?? '0') > 0n
  // USD of what a buy spends or a sell receives: SOL at the chart's price; a stock at its own (app/api/quote-assets).
  const usdRaw = direction === 'buy' ? (validAmount ? inputRaw : null) : liveQuote?.outputAmount
  const usdAmount = stock ? stockUsdLabel(usdRaw, units) : formatUsdEstimate(usdRaw, usdPerSol)
  if (quote?.unavailable && !resultCard) return <div className="trade-card graduated-trade"><h2>Trading unavailable</h2><p>This market's pair is not on repo.ing's list of supported pairs right now, so trades are paused here.</p></div>
  if (!tradingOpen && !busy && !resultCard) return <div className="trade-card graduated-trade"><h2>{curve.status === 'graduated' ? 'This market has graduated' : 'Migration in progress'}</h2><p>{stock && curve.status === 'graduated' ? `Bonding-curve trades have ended. Trading in the graduated pool is not open here yet for ${quote.symbol} pairs.` : 'Bonding-curve trades have ended. We are checking the destination pool; trading resumes here once it is verified. This page updates automatically.'}</p></div>
  const buying = direction === 'buy'
  // Labels before a stock pair's units load; amounts wait for the units themselves.
  const payUnits = units ?? { symbol: quote?.symbol ?? 'SOL', decimals: quote?.decimals ?? 9 }
  // A stock pair's stock is shown as wallets show it; SOL and the market token are shown as they are.
  const shownQuote = raw => raw === null || raw === undefined || !units?.scale ? raw : shownUnits(raw, units)
  const receiveUnit = buying ? market.symbol : payUnits.symbol, receiveDecimals = buying ? 6 : payUnits.decimals
  const quoteLoading = quoteStatus === 'Calculating quote…' || quoteStatus === 'Refreshing quote…'
  const shownReceive = buying ? (liveQuote ? liveQuote.outputAmount : minimumOut) : shownQuote(liveQuote ? liveQuote.outputAmount : minimumOut)
  const minimumReceive = buying ? (liveQuote ? liveQuote.minimumAmountOut : minimumOut) : shownQuote(liveQuote ? liveQuote.minimumAmountOut : minimumOut)
  const quoteRetry = Boolean(quoteStatus) && !quoteLoading && validAmount
  // Until a stock pair's units load, the pay field's own line says so (loading, or Retry) and the balance waits quietly.
  const balanceShown = buying
    ? !units ? { loading: false, error: false, label: null }
      : { loading: payBalanceLoading, error: payBalanceError,
        label: payBalance === null ? null : stock ? `${tokenBalanceLabel(shownQuote(payBalance), units.decimals)} ${units.symbol}` : `${formatSolDisplay(payBalance)} SOL`,
        exact: payBalance === null ? undefined : `${formatUnits(shownQuote(payBalance), units.decimals)} ${units.symbol}` }
    : { loading: balanceLoading, error: balanceError, label: balance === null ? null : `${tokenBalanceLabel(balance)} ${market.symbol}`, exact: balance === null ? undefined : `${formatUnits(balance, 6)} ${market.symbol}` }
  const costNote = costs
    ? `${BigInt(costs.refundableDeposit) > 0n ? `${formatUnits(costs.required)} SOL needed up front; the temporary deposit returns in this transaction. ` : ''}Estimate checked again before signing.`
    : !(liveQuote || preparedCosts) ? '' : !wallet ? 'Connect a wallet to see network fees and account deposits.'
      : currentCosts?.loading ? 'Checking network fees and account deposits…' : 'Network cost estimate unavailable. Checked again before wallet approval.'
  const submitLabel = tradeButtonLabel({ direction, symbol: market.symbol, quoteSymbol: payUnits.symbol, validAmount, buyExceedsBalance, sellExceedsBalance,
    costShortfall, quoteShortfall })
  return <><div className="trade-card" id="trade-panel" ref={panelRef} tabIndex={-1} aria-label={`Trade ${market.symbol}`}>
    <div className="trade-tabs" role="tablist" aria-label="Trade direction">
      <button disabled={busy} role="tab" data-side="buy" aria-selected={buying} className={buying ? 'selected' : ''} onClick={() => selectDirection('buy')}>Buy</button>
      <button disabled={busy} role="tab" data-side="sell" aria-selected={!buying} className={buying ? '' : 'selected'} onClick={() => selectDirection('sell')}>Sell</button>
    </div>
    <form onSubmit={submit} aria-busy={busy}>
      <div className="trade-field">
        <div className="trade-field-head"><label htmlFor="trade-amount">You {buying ? 'pay' : 'sell'}</label><TradeBalance wallet={wallet} {...balanceShown}
          onConnect={() => connect().catch(() => {})} onRetry={() => { setBalanceRefresh(value => value + 1); setStockInfoRefresh(value => value + 1) }}/></div>
        <div className="trade-field-main"><input id="trade-amount" disabled={busy || !units} aria-describedby="trade-quote-hint" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={e => chooseAmount(e.target.value)} required/><span className="trade-unit">{buying ? payUnits.symbol : market.symbol}</span></div>
        <div className="trade-field-foot">
          {buying && usdAmount && <span className="trade-usd">≈ {usdAmount}</span>}
          {!units && <span className="trade-usd" role="status">{stockInfoError ? <>Couldn't load {payUnits.symbol} <button type="button" className="trade-field-action" onClick={() => setStockInfoRefresh(value => value + 1)}>Retry</button></> : `Loading ${payUnits.symbol}…`}</span>}
          {buying ? stock
            ? <PercentAmounts disabled={busy || !units} amount={amount} decimals={payUnits.decimals} label="Buy amount shortcuts"
              preset={percent => payBalance === null || !units ? '' : shownPercentAmount(payBalance, percent, units)}
              describe={percent => `Spend ${percent}% of your ${payUnits.symbol} balance`} onSelect={chooseAmount}/>
            : <BuyPresets disabled={busy} amount={amount} solBalance={payBalance} onSelect={chooseAmount}/>
            : <PercentAmounts disabled={busy || !units} amount={amount} decimals={6} label="Sell amount shortcuts"
              preset={percent => balance === null ? '' : sellAmountForPercent(balance, percent)}
              describe={percent => `Sell ${percent}% of your token balance`} onSelect={chooseAmount}/>}
        </div>
      </div>
      <button type="button" className="trade-flip" disabled={busy} onClick={() => selectDirection(buying ? 'sell' : 'buy')}
        aria-label={`Switch to ${buying ? 'selling' : 'buying'} ${market.symbol}`} title={buying ? 'Switch to sell' : 'Switch to buy'}><ArrowDown size={16} aria-hidden="true"/></button>
      <div className="trade-field is-output">
        <div className="trade-field-head"><span id="trade-receive-label">{minimumOut && !liveQuote ? 'Minimum receive' : 'You receive'}</span>{liveQuote && <span className="trade-field-tag">Estimate</span>}</div>
        <div className={`trade-field-main trade-quote${shownReceive ? '' : quoteStatus ? ' is-waiting' : ' is-empty'}`} role="status" aria-live="polite" aria-busy={quoteLoading} aria-labelledby="trade-receive-label">
          <span className="trade-quote-value" title={shownReceive ? `${formatUnits(shownReceive, receiveDecimals)} ${receiveUnit}` : undefined}>{quoteStatus === 'Calculating quote…' && <LoadingSignal/>}{shownReceive ? quoteAmountLabel(shownReceive, receiveDecimals) : quoteStatus || (amount ? '—' : '0.00')}{liveQuote && quoteStatus === 'Refreshing quote…' && <LoadingSignal/>}</span>
          <span className="trade-unit">{receiveUnit}</span>
        </div>
        {((!buying && usdAmount) || quoteRetry) && <div className="trade-field-foot">
          {!buying && usdAmount && <span className="trade-usd">≈ {usdAmount}</span>}
          {quoteRetry && <button type="button" className="trade-field-action" disabled={busy} onClick={() => setQuoteRefresh(value => value + 1)}>Retry quote</button>}
        </div>}
      </div>
      <div className="trade-settings"><SlippageSetting value={slippageBps} onChange={chooseSlippage} disabled={busy}/></div>
      {(minimumReceive || liveQuote || costs) && <dl className="trade-details">
        {minimumReceive && <div><dt title={`The trade fails instead of filling below this (${slippageLabel(shownSlippage)} max slippage). Refreshed before wallet confirmation.`}>Minimum received</dt>
          <dd title={`${formatUnits(minimumReceive, receiveDecimals)} ${receiveUnit}`}>{quoteAmountLabel(minimumReceive, receiveDecimals)} {receiveUnit}</dd></div>}
        {minimumReceive && shownSlippage !== slippageBps && <div><dt>Max slippage <small>(this trade)</small></dt><dd>{slippageLabel(shownSlippage)}</dd></div>}
        {liveQuote && <>
          <div><dt title="Difference between the fee-excluded execution price and current pool spot price">Price impact</dt><dd className={liveQuote.priceImpactPercent >= 5 ? 'is-high' : undefined}>{Number.isFinite(liveQuote.priceImpactPercent) ? `${liveQuote.priceImpactPercent.toFixed(2)}%` : '—'}</dd></div>
          <div><dt>Trading fee <small>(included)</small></dt><dd>{stock
            ? `${quoteAmountLabel(shownQuote(liveQuote.tradingFeeLamports), payUnits.decimals)} ${payUnits.symbol}`
            : `${formatSolDisplay(liveQuote.tradingFeeLamports)} SOL`}</dd></div>
          {launchFeeNote && <div><dt>Launch fee <small>(at this quote)</small></dt><dd>{feePercentLabel(liveQuote.launchFee.feeNumerator)}</dd></div>}
        </>}
        {costs && <>
          <div><dt>Network + priority fee</dt><dd>≈ {formatUnits(costs.networkFee)} SOL</dd></div>
          {BigInt(costs.accountDeposits) > 0n && <div><dt>Token account deposit</dt><dd>{formatUnits(costs.accountDeposits)} SOL</dd></div>}
          {BigInt(costs.refundableDeposit) > 0n && <div><dt>Temporary deposit <small>(returned)</small></dt><dd>{formatUnits(costs.refundableDeposit)} SOL</dd></div>}
          <div className="trade-details-total"><dt>{buying && !stock ? 'Total spend' : 'SOL costs'}</dt><dd>≈ {formatUnits(costs.total)} SOL</dd></div>
        </>}
      </dl>}
      {costNote && <p className="trade-note">{costNote}</p>}
      {quoteShortfall && <p className="trade-funding-note" role="status">You need ≈ {shownShortfall(costs.quoteShortfall, units)} more {payUnits.symbol} to cover this trade.</p>}
      {costShortfall ? <p className="trade-funding-note" role="status">You need ≈ {formatUnits((BigInt(costs.shortfall) + 999n) / 1000n * 1000n)} more SOL to cover this trade.</p>
        : buyExceedsBalance && !stock && <p className="trade-funding-note" role="status">Leave some SOL for network fees and token-account costs.</p>}
      {/* The size guide is sized in SOL; a stock pair has none yet. */}
      {buying && !stock && (!curve || curve.status === 'active') && <TradeSizeGuide repoId={market.repoId} disabled={busy} onSelect={chooseAmount}/>}
      {launchFeeNote && <p className="trade-impact-warning trade-launch-fee" role="status">{launchFeeNote}</p>}
      {liveQuote?.priceImpactPercent >= 5 && <p className="trade-impact-warning" role="status">High price impact. This trade moves the execution price by about {liveQuote.priceImpactPercent.toFixed(2)}% before fees. Consider a smaller amount.</p>}
      <p className="sr-only" id="trade-quote-hint">{minimumReceive ? `Minimum after ${slippageLabel(shownSlippage)} slippage: ${formatUnits(minimumReceive, receiveDecimals, 6)} ${receiveUnit}. Refreshed before wallet confirmation.` : 'Quote updates as you enter an amount.'}</p>
      <button className="button primary trade-submit" type="submit" disabled={busy || !available || !tradingOpen || !units || !validAmount || buyExceedsBalance || costShortfall || quoteShortfall || sellExceedsBalance || resultCard?.state === 'pending'}>{busy && <LoadingSignal/>}{busy ? stage || 'Preparing…' : submitLabel}</button>
      <TransactionStatus stage={busy ? stage : ''}/>
      <TradeIdentity wallet={wallet} direction={direction} x={x}/>
      {graduatedPool && <p className="trade-venue">Trades in the graduated Meteora pool · <a href={graduatedPool.url} target="_blank" rel="noopener noreferrer">View pool ↗</a></p>}
    </form>
    <TradeResultCard result={resultCard} symbol={market.symbol} mint={market.mint} fullName={market.fullName} source={market.source} onClose={() => setResultCard(null)} onCheck={() => checkTrade(resultCard)} onRetry={retryWithSlippage}
      xLink={x.link} xNudge={Boolean(wallet && x.known && !x.off && !hasXHandle(x.link))} quoteUnits={stock ? units : null}/>
  </div>{!panelVisible && !resultCard && <nav className="mobile-trade-actions" aria-label="Quick trade navigation"><span>${market.symbol}</span><button type="button" className="button primary" disabled={busy || !available} onClick={() => openTrade('buy')}>Buy</button><button type="button" className="button outline" disabled={busy || !available} onClick={() => openTrade('sell')}>Sell</button></nav>}</>
}
