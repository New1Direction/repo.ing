'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useWallet } from './wallet'
import { TransactionStatus } from './ui'
import { formatSolDisplay, formatUnits, parseUnits } from '../lib/format.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { bundleAction, readBundle } from '../lib/bundle-client.mjs'
import { PHASE_LABELS, PHASE_NOTES, raiseFigures, raisePhase, raisedPercent, remainingLamports, sharePercent, timeLeft } from '../lib/bundle-view.mjs'
import '../bundles.css'

// The raise page's live part (app/(site)/bundle/[id]): progress, deadline, backers, the deposit form and the connected wallet's
// share with its refund or claim. initial: the server's read (app/lib/bundle-state.mjs), refreshed every 15 s while visible.

const REFRESH_MS = 15_000
const sol = lamports => formatSolDisplay(lamports)

// One action at a time (deposit, refund, claim): its progress, its error, and a refresh once it landed.
export function useBundleAction(onDone) {
  const { wallet, connect, provider } = useWallet()
  const [stage, setStage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const working = useRef(false)
  async function run(id, action, options = {}) {
    if (working.current) return
    working.current = true; setBusy(true); setError('')
    try {
      const address = wallet || await connect()
      const result = await bundleAction(id, action, { wallet: address, provider, onStage: setStage, ...options })
      setStage(result.confirmed ? 'Confirmed' : 'Sent. Waiting for Solana to confirm it…')
      onDone?.(result)
    } catch (cause) { setError(cause.message || 'The transaction did not go through.'); setStage('') }
    finally { working.current = false; setBusy(false) }
  }
  return { run, stage, error, busy }
}

// The wallet's state in this bundle, read with the bundle every REFRESH_MS while the page is visible; refresh(): read now.
function useBundleState(initial) {
  const { wallet } = useWallet()
  const [state, setState] = useState(initial), [tick, setTick] = useState(0)
  useEffect(() => {
    let active = true
    const stop = visiblePolling(async () => {
      try { const next = await readBundle(initial.id, wallet); if (active) setState(next) } catch { /* the last read stays on screen */ }
    }, REFRESH_MS)
    return () => { active = false; stop() }
  }, [initial.id, wallet, tick])
  return [state, () => setTick(value => value + 1), wallet]
}

// Starts from the server's clock so the first render matches it, then counts every second.
function useNow(start) {
  const [now, setNow] = useState(() => Date.parse(start))
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  return now
}

export function BundleRaise({ initial }) {
  const [state, refresh, wallet] = useBundleState(initial)
  const now = useNow(initial.checkedAt)
  const phase = raisePhase(state, now), figures = raiseFigures(state)
  const percent = raisedPercent(figures.raised, figures.target), left = timeLeft(figures.deadline, now)
  return <div className="bundle-raise">
    <section className="inner-card bundle-progress-card" aria-labelledby="bundle-progress-title">
      <div className="bundle-status-line"><span className={`bundle-phase is-${phase}`}>{PHASE_LABELS[phase]}</span>
        {['raising', 'opening'].includes(phase) && left && <span className="bundle-countdown" aria-live="off">{left}</span>}</div>
      <h2 id="bundle-progress-title" className="bundle-raised">{sol(figures.raised)} <span>of {sol(figures.target)} SOL raised</span></h2>
      <div className="bundle-progress" role="progressbar" aria-label="Raised toward the target" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        aria-valuetext={`${sol(figures.raised)} of ${sol(figures.target)} SOL`}><span style={{ transform: `scaleX(${percent / 100})` }}/></div>
      <dl className="bundle-facts">
        <div><dt>Raised</dt><dd>{percent}%</dd></div>
        <div><dt>Backers</dt><dd>{state.backers ?? '—'}</dd></div>
        <div><dt>Deadline</dt><dd><time dateTime={figures.deadline}>{new Date(figures.deadline).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</time></dd></div>
        <div><dt>Minimum deposit</dt><dd>{sol(figures.minDeposit)} SOL</dd></div>
      </dl>
      <p className="bundle-note">{PHASE_NOTES[phase]}</p>
      {phase === 'launched' && state.marketMint && <Link className="button primary" href={`/token/${state.marketMint}`}>Open the ${state.tokenSymbol} market</Link>}
    </section>
    <div className="bundle-side">
      {phase === 'raising' && <DepositForm state={state} figures={figures} onDone={refresh}/>}
      <BackerShare state={state} wallet={wallet} phase={phase} onDone={refresh}/>
    </div>
  </div>
}

// A deposit within what the raise still needs; from the minimum, or exactly what fills it.
function DepositForm({ state, figures, onDone }) {
  const remaining = remainingLamports(figures.raised, figures.target), minimum = BigInt(figures.minDeposit)
  const [amount, setAmount] = useState('')
  const action = useBundleAction(() => { setAmount(''); onDone() })
  let lamports = null, problem = ''
  try { lamports = BigInt(parseUnits(amount.trim(), 9)) } catch { lamports = null }
  if (lamports !== null && lamports > remaining) problem = `This raise needs only ${sol(remaining)} SOL more.`
  else if (lamports !== null && lamports < minimum && lamports !== remaining) problem = `Deposits start at ${sol(minimum)} SOL; only the deposit that fills the raise may be smaller.`
  const presets = [minimum, 100_000_000n, 500_000_000n, 1_000_000_000n].filter(value => value >= minimum && value < remaining)
  function submit(event) {
    event.preventDefault()
    if (lamports === null || problem) return
    action.run(state.id, 'deposit', { lamports: lamports.toString() })
  }
  return <form className="inner-card bundle-deposit" onSubmit={submit} aria-labelledby="bundle-deposit-title">
    <h3 id="bundle-deposit-title">Back this bundle</h3>
    <div className="launch-buy-presets" role="group" aria-label="Deposit presets">
      {presets.map(value => <button key={value.toString()} type="button" aria-pressed={lamports === value} onClick={() => setAmount(formatUnits(value, 9))}>{sol(value)} SOL</button>)}
      <button type="button" aria-pressed={lamports === remaining} onClick={() => setAmount(formatUnits(remaining, 9))}>Fill ({sol(remaining)})</button>
    </div>
    <label className="field-label" htmlFor="bundle-deposit">Deposit</label>
    <div className="input-suffix"><input id="bundle-deposit" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount}
      onChange={event => setAmount(event.target.value)} disabled={action.busy}/><span>SOL</span></div>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    <button type="submit" className="button primary" disabled={action.busy || lamports === null || Boolean(problem)}>{action.busy ? action.stage || 'Preparing…' : 'Deposit'}</button>
    <p className="form-fineprint">One share per lamport. If the raise fails, you take back exactly what you deposited.</p>
    <TransactionStatus stage={action.busy ? '' : action.stage} error={action.error}/>
  </form>
}

// The connected wallet in this bundle: what it deposited, its share, what it can claim, and its refund once a raise failed.
export function BackerShare({ state, wallet, phase, onDone }) {
  const { connect } = useWallet()
  const action = useBundleAction(onDone)
  if (!wallet) return <div className="inner-card bundle-share"><h3>Your share</h3><p>Connect your wallet to see your deposit and fees.</p>
    <button type="button" className="button outline" onClick={() => connect().catch(() => {})}>Connect wallet</button></div>
  const backer = state.wallet?.address === wallet ? state.wallet.backer : undefined
  if (backer === undefined) return <div className="inner-card bundle-share" aria-busy="true"><h3>Your share</h3><p role="status">Reading your deposit…</p></div>
  if (!backer) return <div className="inner-card bundle-share"><h3>Your share</h3><p>This wallet has not backed this bundle.</p></div>
  const pending = BigInt(backer.pending), share = BigInt(backer.shares) > 0n && backer.shareBps === 0 ? '<0.01%' : sharePercent(backer.shareBps)
  return <div className="inner-card bundle-share"><h3>Your share</h3>
    <dl className="bundle-facts">
      <div><dt>Deposited</dt><dd>{sol(backer.shares)} SOL</dd></div>
      <div><dt>Share of the raise</dt><dd>{share}</dd></div>
      {phase === 'launched' && <><div><dt>Claimable fees</dt><dd>{sol(backer.pending)} SOL</dd></div><div><dt>Claimed so far</dt><dd>{sol(backer.paid)} SOL</dd></div></>}
    </dl>
    {phase === 'failed' && <button type="button" className="button primary" disabled={action.busy} onClick={() => action.run(state.id, 'refund')}>
      {action.busy ? action.stage || 'Preparing…' : `Refund ${sol(backer.shares)} SOL`}</button>}
    {phase === 'launched' && <button type="button" className="button primary" disabled={action.busy || pending <= 0n} onClick={() => action.run(state.id, 'claim')}>
      {action.busy ? action.stage || 'Preparing…' : pending > 0n ? `Claim ${sol(pending)} SOL` : 'Nothing to claim yet'}</button>}
    {phase === 'launched' && <p className="form-fineprint">Fees arrive as SOL in your wallet.</p>}
    <TransactionStatus stage={action.busy ? '' : action.stage} error={action.error}/>
  </div>
}

// The token page's vault card: the connected wallet's claimable fees for this market's bundle, with its claim.
export function BundleBackerPanel({ initial }) {
  const [state, refresh, wallet] = useBundleState(initial)
  return <BackerShare state={state} wallet={wallet} phase={raisePhase(state)} onDone={refresh}/>
}
