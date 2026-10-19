'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, Check, LoaderCircle, X } from 'lucide-react'
import { useWallet } from './wallet'
import { useHookWalletSession } from './hooklab-wallet-signin'
import { SLIPPAGE_CHOICES, estimateTrade, formatUnits, maxBuyLamports, parseUnits, planBuy, planSell, sol, tradeIntent } from '../lib/hooklab-trade-math.mjs'
import { callTrade, expectOperation, forgetOperation, isFinal, pendingOperations, rememberOperation, runOperation } from '../lib/hooklab-trade-runner.mjs'
import '../trade-panel.css'

// Rent for one 204-byte Hook Lab holding at today's rent rate; the server's review uses the live value before signing.
const HOLDING_RENT = '1686560'
const STEP_LABELS = { fund: 'Add SOL to Hook Lab', buy: 'Buy', sell: 'Sell', withdraw: 'Withdraw SOL to your wallet' }
const STATUS_TEXT = { review: 'Preparing…', sign: 'Approve in your wallet', send: 'Sending…', confirm: 'Confirming on Solana…' }
const explorer = signature => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`

async function readMarket(mint, wallet) {
  const response = await fetch(`/api/hook-lab/market/${mint}${wallet ? `?wallet=${wallet}` : ''}`, { cache: 'no-store' })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw Error(value.error || 'Trading data is unavailable right now.')
  return value
}

// Buy and sell a Hooks coin with SOL. Each step is its own wallet approval with an exact server review; SOL moves
// into Hook Lab (bridged SOL) for a buy and back out after a sell, with nothing left stranded if a step fails.
export function HookTradePanel({ mint, genesisHash, initial = null }) {
  const { wallet, connect, provider } = useWallet()
  const session = useHookWalletSession(genesisHash)
  const [view, setView] = useState(initial)
  const [side, setSide] = useState('buy'), [amount, setAmount] = useState(''), [slippageBps, setSlippageBps] = useState(300)
  const [steps, setSteps] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null)
  const running = useRef(false)
  const market = view?.market, mine = view?.wallet && view.wallet.address === wallet ? view.wallet : null, symbol = market ? `$${market.symbol}` : ''
  const refresh = useCallback(async () => { try { const next = await readMarket(mint, wallet); setView(next); return next } catch (e) { setError(e.message); return null } }, [mint, wallet])
  useEffect(() => { refresh(); const timer = setInterval(() => { if (!running.current) refresh() }, 10000); return () => clearInterval(timer) }, [refresh])

  const buying = side === 'buy', decimals = buying ? 9 : market?.decimals ?? 6, raw = parseUnits(amount, decimals)
  const estimate = useMemo(() => market && raw ? estimateTrade(market, { side, amount: raw, coinBalance: BigInt(mine?.coin ?? 0), slippageBps }) : null, [market, raw, side, mine?.coin, slippageBps])
  const plan = useMemo(() => !raw || !mine ? null : buying ? planBuy({ amount: raw, wallet: mine, rentLamports: HOLDING_RENT }) : planSell({ amount: raw, wallet: mine }), [raw, mine, buying])
  const bridged = BigInt(mine?.bridgedSol ?? 0), coinBalance = BigInt(mine?.coin ?? 0)
  // Leave 2% headroom under the cap: the curve can move before the buy lands, and the cap is enforced on chain.
  const maxBuy = useMemo(() => { const max = market ? maxBuyLamports(market, coinBalance) : null; return max === null ? null : max * 98n / 100n }, [market, coinBalance])
  const capNote = buying && estimate?.error && /max per wallet/.test(estimate.error)
    ? (maxBuy ? `You can buy up to about ${sol(maxBuy, 4)} right now (${market.capBps / 100}% of the supply per wallet).` : 'This wallet already holds the most this coin allows.') : ''
  const tooMuch = raw && mine && (buying ? false : raw > coinBalance)

  // One operation through review -> wallet -> send -> confirm, tracked in the step list and kept across reloads.
  // A trade that executed but landed after its reviewed slot settles as review-required: it still happened.
  const step = async (address, index, create, kind) => {
    const signingId = crypto.randomUUID()
    rememberOperation(localStorage, { wallet: address, signingId, kind, mint, createdAt: Date.now() })
    const update = patch => setSteps(list => list.map((s, i) => i === index ? { ...s, ...patch } : s))
    let last = null, op
    try {
      op = await runOperation({ create, signingId, wallet: address, genesisHash, signTransaction: tx => provider().signTransaction(tx),
        onStatus: status => update({ status }), onOperation: o => { last = o; if (o.signature) update({ signature: o.signature }) } })
    } catch (e) {
      // Never signed (refused in the wallet, expired, or refused by the server): nothing to finish later.
      if (!last || last.status === 'reviewed') forgetOperation(localStorage, signingId)
      update({ status: 'failed' }); throw e
    }
    if (isFinal(op.status)) forgetOperation(localStorage, signingId)
    const executed = op.status === 'finalized-success' || (op.status === 'review-required' && op.settlement?.executionStatus === 'finalized-executed')
    update({ status: executed ? 'done' : 'failed', signature: op.signature })
    if (!executed) throw Error(op.status === 'finalized-failure' ? `${STEP_LABELS[kind]} failed on Solana. Only its network fee was charged.`
      : op.status === 'review-required' ? 'This transaction needs a manual check. It is saved; nothing more will be signed for it.'
      : 'Still confirming. Your transaction is saved; this page keeps checking it.')
    return op
  }

  // The SOL a sale paid into Hook Lab can take a few seconds to show up in finalized reads; wait for it, then withdraw
  // exactly what is there (retrying while the server's view catches up). Returns the lamports actually withdrawn.
  const withdrawProceeds = async (address, index, load, expected) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const balance = BigInt((await load())?.wallet?.bridgedSol ?? 0)
      if (balance >= expected && balance > 0n) {
        try { await step(address, index, { action: 'withdraw', request: { lamports: String(balance) } }, 'withdraw'); return balance }
        catch (e) { if (!/at most your SOL in Hook Lab/.test(e.message)) throw e }
      }
      await new Promise(resolve => setTimeout(resolve, 2500))
    }
    throw Error('Your SOL from the sale is in Hook Lab. Use Withdraw below to send it to your wallet.')
  }

  async function trade(event) {
    event.preventDefault()
    if (running.current || !market) return
    // Connecting needs no amount; trading does.
    if (!wallet) { try { await connect() } catch {} return }
    if (!raw || estimate?.error || tooMuch) return
    running.current = true; setBusy(true); setError(''); setResult(null)
    let funded = false
    try {
      const address = wallet
      if (!session.signedIn && !await session.signIn()) return
      await resumePending(address)
      if (pendingOperations(localStorage, address).length) throw Error('Your last transaction is still being confirmed. This page finishes it first; try again in a moment.')
      const load = async () => { const next = await readMarket(mint, address); setView(next); return next }
      const fresh = await load(), me = fresh?.wallet
      if (!me) throw Error('Could not read your balances. Try again.')
      if (!fresh.tradingOpen) throw Error('Trading opens to everyone soon. We are testing buys, sells and withdrawals first.')
      if (buying) {
        // Everything that could refuse the buy is checked before any SOL moves into Hook Lab.
        const first = estimateTrade(fresh.market, { side: 'buy', amount: raw, coinBalance: BigInt(me.coin ?? 0), slippageBps })
        if (first.error) throw Error(first.error)
        const p = planBuy({ amount: raw, wallet: me, rentLamports: HOLDING_RENT })
        if (p.shortfall > 0n) throw Error(`You need about ${sol(p.shortfall, 5)} more SOL for this buy, including Hook Lab deposits and fees.`)
        if (p.steps[0].kind === 'fund' && !fresh.funding) throw Error('Adding SOL to Hook Lab is paused right now, so new buys are paused. Selling and withdrawing still work.')
        setSteps(p.steps.map(s => ({ kind: s.kind, status: 'todo' })))
        let index = 0
        if (p.steps[0].kind === 'fund') { await step(address, index++, { action: 'fund', request: { mint, lamports: String(p.steps[0].lamports) } }, 'fund'); funded = true }
        const now = await load(), e = estimateTrade(now.market, { side: 'buy', amount: raw, coinBalance: BigInt(now.wallet.coin ?? 0), slippageBps })
        if (e.error) throw Error(e.error)
        const op = await step(address, index, { action: 'quote', request: tradeIntent(now.market, 'buy', raw, e.minAmountOut) }, 'buy')
        setResult({ kind: 'buy', received: op.settlement?.quote?.delivered ?? e.delivered })
      } else {
        if (raw > BigInt(me.coin ?? 0)) throw Error(`You hold ${formatUnits(BigInt(me.coin ?? 0), market.decimals, 2)} ${symbol}.`)
        const e = estimateTrade(fresh.market, { side: 'sell', amount: raw, slippageBps })
        if (e.error) throw Error(e.error)
        const p = planSell({ amount: raw, wallet: me, rentLamports: HOLDING_RENT })
        if (p.shortfall > 0n) throw Error(`You need about ${sol(p.shortfall, 5)} more SOL in your wallet for the network fees.`)
        setSteps(p.steps.map(s => ({ kind: s.kind, status: 'todo' })))
        let index = 0
        if (p.steps[0].kind === 'fund') await step(address, index++, { action: 'fund', request: { mint, lamports: '0' } }, 'fund')
        const before = BigInt(me.bridgedSol ?? 0)
        const op = await step(address, index++, { action: 'quote', request: tradeIntent(fresh.market, 'sell', raw, e.minAmountOut) }, 'sell')
        funded = true
        const delivered = BigInt(op.settlement?.quote?.delivered ?? e.minAmountOut)
        setResult({ kind: 'sell', received: await withdrawProceeds(address, index, load, before + delivered) })
      }
      setAmount('')
    } catch (e) {
      const message = e.message || 'Something went wrong. Nothing more was signed.'
      setError(funded && !/Hook Lab/.test(message) ? `${message} Your SOL is safe in Hook Lab: use Withdraw below to send it back to your wallet.` : message)
    }
    finally { running.current = false; setBusy(false); refresh() }
  }

  async function withdrawAll() {
    if (running.current || bridged <= 0n) return
    running.current = true; setBusy(true); setError(''); setResult(null)
    try {
      if (!session.signedIn && !await session.signIn()) return
      setSteps([{ kind: 'withdraw', status: 'todo' }])
      await step(wallet, 0, { action: 'withdraw', request: { lamports: String(bridged) } }, 'withdraw')
      setResult({ kind: 'withdraw', received: bridged })
    } catch (e) { setError(e.message || 'Withdraw failed. Nothing more was signed.') }
    finally { running.current = false; setBusy(false); refresh() }
  }

  // Finish confirming anything a reload or a lost connection interrupted (never re-signs: unsigned reviews are dropped).
  const resumePending = useCallback(async address => {
    for (const entry of pendingOperations(localStorage, address)) {
      try {
        const ids = { signingId: entry.signingId, wallet: address, genesisHash }
        const op = expectOperation(await callTrade({ action: 'get', signingId: entry.signingId }), ids)
        if (op.status === 'reviewed' || isFinal(op.status)) { forgetOperation(localStorage, entry.signingId); continue }
        const final = await runOperation({ create: { action: 'get' }, ...ids, signTransaction: async () => { throw Error('unsigned') } })
        if (isFinal(final.status)) forgetOperation(localStorage, entry.signingId)
      } catch {}
    }
    refresh()
  }, [genesisHash, refresh])
  useEffect(() => { if (wallet && session.signedIn) resumePending(wallet) }, [wallet, session.signedIn, resumePending])

  if (!market) return <div className="trade-card"><h2>Buy &amp; sell</h2><p className="trade-note">{error || 'Loading this coin…'}</p></div>
  // Buy shortcuts that can actually fill, plus Max; sell shortcuts are shares of what you hold.
  const presets = buying ? [...['0.01', '0.05', '0.1', '0.5'].filter(p => maxBuy === null || parseUnits(p, 9) <= maxBuy).slice(0, 3), ...(maxBuy ? ['max'] : [])] : [25, 50, 100]
  const cta = !wallet ? 'Connect wallet' : !session.signedIn ? `Sign in and ${side} ${symbol}` : `${buying ? 'Buy' : 'Sell'} ${symbol}`
  return <div className="trade-card hooks-trade" aria-label={`Trade ${symbol}`}>
    <div className="trade-tabs" role="tablist" aria-label="Trade direction">
      {['buy', 'sell'].map(value => <button key={value} type="button" role="tab" data-side={value} aria-selected={side === value} className={side === value ? 'selected' : ''} disabled={busy}
        onClick={() => { setSide(value); setAmount(''); setError(''); setResult(null) }}>{value === 'buy' ? 'Buy' : 'Sell'}</button>)}
    </div>
    {view && !view.tradingOpen && <p className="hooks-trade-soon" role="status">Trading opens to everyone soon. We are testing buys, sells and withdrawals first.</p>}
    <form onSubmit={trade} aria-busy={busy}>
      <div className="trade-field">
        <div className="trade-field-head"><label htmlFor="hooks-trade-amount">You {buying ? 'pay' : 'sell'}</label>
          {mine && <span className="trade-balance">{buying ? `Wallet ${sol(mine.lamports)}` : `You hold ${formatUnits(coinBalance, market.decimals, 2)}`}</span>}</div>
        <div className="trade-field-main"><input id="hooks-trade-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={busy}
          onChange={e => { setAmount(e.target.value.replace(',', '.')); setError('') }}/><span className="trade-unit">{buying ? 'SOL' : symbol}</span></div>
        <div className="trade-field-foot"><div className="trade-quick-actions" role="group" aria-label={buying ? 'Buy amounts' : 'Sell amounts'}>
          {presets.map(p => <button type="button" key={p} disabled={busy || (!buying && coinBalance === 0n)}
            onClick={() => setAmount(buying ? (p === 'max' ? formatUnits(maxBuy, 9, 6).replace(/,/g, '') : p) : formatUnits(coinBalance * BigInt(p) / 100n, market.decimals).replace(/,/g, ''))}>
            {buying ? (p === 'max' ? 'Max' : `${p} SOL`) : `${p}%`}</button>)}</div></div>
      </div>
      <div className="trade-flip" aria-hidden="true"><ArrowDown size={16}/></div>
      <div className="trade-field is-output">
        <div className="trade-field-head"><span>You receive</span>{estimate && !estimate.error && <span className="trade-field-tag">Estimate</span>}</div>
        <div className="trade-field-main trade-quote" role="status" aria-live="polite"><span className="trade-quote-value">
          {estimate?.error ? '—' : estimate ? formatUnits(estimate.delivered, buying ? market.decimals : 9, buying ? 0 : 6) : '0.00'}</span>
          <span className="trade-unit">{buying ? symbol : 'SOL'}</span></div>
      </div>
      <div className="trade-settings hooks-slippage" role="group" aria-label="Max slippage"><span>Max slippage</span>
        {SLIPPAGE_CHOICES.map(bps => <button type="button" key={bps} aria-pressed={slippageBps === bps} disabled={busy} onClick={() => setSlippageBps(bps)}>{bps / 100}%</button>)}</div>
      {estimate?.error && <p className="inline-error" role="alert">{estimate.error} {capNote}</p>}
      {tooMuch && <p className="inline-error" role="alert">You hold {formatUnits(coinBalance, market.decimals, 2)} {symbol}.</p>}
      {estimate && !estimate.error && <dl className="trade-details">
        <div><dt>Minimum received</dt><dd>{formatUnits(estimate.minAmountOut, buying ? market.decimals : 9, buying ? 0 : 6)} {buying ? symbol : 'SOL'}</dd></div>
        <div><dt>Price impact</dt><dd className={estimate.priceImpactBps >= 500 ? 'is-high' : undefined}>{(estimate.priceImpactBps / 100).toFixed(2)}%</dd></div>
        <div><dt>Creator fee <small>(included, {market.creatorFeeBps / 100}%)</small></dt><dd>{sol(estimate.creatorFee, 6)}</dd></div>
        {plan?.steps.some(s => s.rentLamports > 0n) && <div><dt>Hook Lab deposits <small>(first trade only)</small></dt><dd>{sol(plan.steps.find(s => s.kind === 'fund').rentLamports, 5)}</dd></div>}
        {plan && <div><dt>Network fees</dt><dd>{sol(plan.steps.reduce((sum, s) => sum + s.feeLamports, 0n), 6)}</dd></div>}
        {plan?.walletCost !== undefined && <div className="trade-details-total"><dt>From your wallet</dt><dd>{sol(plan.walletCost, 5)}</dd></div>}
      </dl>}
      {plan && plan.steps.length > 1 && !steps && <p className="trade-note">{plan.steps.length} approvals in your wallet: {plan.steps.map(s => s.kind === 'buy' || s.kind === 'sell' ? `${STEP_LABELS[s.kind]} ${symbol}` : STEP_LABELS[s.kind]).join(', then ')}.</p>}
      <button type="submit" className="button primary trade-submit" disabled={busy || session.busy || (!!wallet && (!raw || !!estimate?.error || !!tooMuch)) || (!!wallet && view && !view.tradingOpen && session.signedIn)}>
        {busy ? 'Working…' : cta}</button>
    </form>
    {steps && <ol className="hooks-trade-steps" aria-label="Progress">{steps.map((s, i) => <li key={i} data-state={s.status}>
      <span aria-hidden="true">{s.status === 'done' ? <Check size={14}/> : s.status === 'failed' ? <X size={14}/> : ['review', 'sign', 'send', 'confirm'].includes(s.status) ? <LoaderCircle size={14} className="image-picker-spinner"/> : i + 1}</span>
      <div><strong>{s.kind === 'buy' || s.kind === 'sell' ? `${STEP_LABELS[s.kind]} ${symbol}` : STEP_LABELS[s.kind]}</strong>
        <small>{STATUS_TEXT[s.status] ?? (s.status === 'done' ? 'Done' : s.status === 'failed' ? 'Stopped' : 'Waiting')}{s.signature && <> · <a href={explorer(s.signature)} target="_blank" rel="noopener noreferrer">Receipt</a></>}</small></div></li>)}</ol>}
    {result && <p className="hooks-trade-result" role="status">{result.kind === 'buy' ? `You bought ${formatUnits(BigInt(result.received), market.decimals, 0)} ${symbol}.`
      : `${sol(result.received, 6)} is back in your wallet.`}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {mine && <div className="hooks-trade-balances">
      <div><span>Wallet</span><strong>{sol(mine.lamports)}</strong></div>
      <div><span>In Hook Lab</span><strong>{sol(bridged, 6)}</strong>{bridged > 0n && view?.funding && <button type="button" className="hooks-text-button" disabled={busy} onClick={withdrawAll}>Withdraw</button>}</div>
      <div><span>{symbol}</span><strong>{formatUnits(coinBalance, market.decimals, 0)}</strong></div>
    </div>}
    <p className="trade-note">Hooks coins trade with SOL moved into Hook Lab. Buying moves it in for you; selling sends it back to your wallet. <Link href="/hooks/blocks">How Hooks work</Link></p>
  </div>
}

