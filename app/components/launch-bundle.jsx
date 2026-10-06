'use client'
import { useRef, useState } from 'react'
import { useWallet } from './wallet'
import { TransactionStatus } from './ui'
import { formatUnits, parseUnits } from '../lib/format.mjs'
import { openBundle } from '../lib/bundle-client.mjs'
import '../bundles.css'

// Bundle launches on the launch form (docs/BUNDLE_LAUNCH.md): the mode choice, the raise's target and deadline, what backers
// should know before they fund one, and opening it. settings: the server's raise terms as plain values (app/(site)/launch/[repo]
// bundleSettings), present only while Bundle launches can be opened.

const sol = lamports => formatUnits(lamports, 9, 2)

// Standard (the launcher launches now) or Bundle (backers fund a raise; repo.ing launches when it is full).
export function LaunchModeChoice({ value, onChange }) {
  return <fieldset className="launch-mode">
    <legend className="field-label">How to launch</legend>
    <div className="launch-mode-options">
      <label className={`launch-mode-option${value ? '' : ' is-selected'}`}>
        <input type="radio" name="launch-mode" value="standard" checked={!value} onChange={() => onChange(false)}/>
        <span className="launch-mode-name">Standard</span><small>You launch the market now, with an optional first buy.</small>
      </label>
      <label className={`launch-mode-option${value ? ' is-selected' : ''}`}>
        <input type="radio" name="launch-mode" value="bundle" checked={value} onChange={() => onChange(true)}/>
        <span className="launch-mode-name">Bundle <span className="muted">(community-funded)</span></span>
        <small>Backers fund a raise. When it is full, the raise buys the first tokens into a vault and backers share its fees.</small>
      </label>
    </div>
  </fieldset>
}

// value: { target (SOL as typed), days }.
export function BundleRaiseFields({ settings, value, onChange }) {
  const presets = [1, 3, 5, 10].map(amount => String(amount)).filter(amount => {
    const lamports = BigInt(parseUnits(amount, 9))
    return lamports >= BigInt(settings.minTargetLamports) && lamports <= BigInt(settings.maxTargetLamports)
  })
  return <div className="bundle-raise-fields">
    <label className="field-label" htmlFor="bundle-target">Raise target</label>
    <div className="launch-buy-presets" role="group" aria-label="Raise target presets">
      {presets.map(amount => <button key={amount} type="button" aria-pressed={value.target === amount} onClick={() => onChange({ ...value, target: amount })}>{amount} SOL</button>)}
    </div>
    <div className="input-suffix"><input id="bundle-target" inputMode="decimal" autoComplete="off" value={value.target}
      onChange={event => onChange({ ...value, target: event.target.value })} aria-describedby="bundle-target-hint"/><span>SOL</span></div>
    <div id="bundle-target-hint" className="field-hint"><span>From {sol(settings.minTargetLamports)} to {sol(settings.maxTargetLamports)} SOL. Deposits start at {sol(settings.minDepositLamports)} SOL.</span></div>
    <div className="field-label" id="bundle-deadline-label">Deadline</div>
    <div className="launch-buy-presets" role="group" aria-labelledby="bundle-deadline-label">
      {settings.deadlineDays.map(days => <button key={days} type="button" aria-pressed={value.days === days} onClick={() => onChange({ ...value, days })}>{days === 1 ? '1 day' : `${days} days`}</button>)}
    </div>
    <p className="launch-buy-hint">All or nothing: if the target is not reached by the deadline, every backer can take a full refund. When it is full, the raise
      (less {settings.opsPercent} for operations) buys the market&apos;s first tokens into a permanent vault in the launch transaction.</p>
  </div>
}

// The side card: what a backer gets, what they do not, and how little most bundles earn today. The figures are the Bundle
// simulation's (docs/BUNDLE_SIMULATION.md): the median bundle, and the best of 52 markets, over their first days.
export function BundleNotes({ settings }) {
  return <div className="inner-card bundle-notes">
    <h3>How a Bundle works</h3>
    <ul>
      <li><strong>Backers earn fees, not tokens.</strong> They get {settings.backerPercent} of this market&apos;s partner trading fees, after the vault&apos;s own
        trading fees are paid back to it. Builders keep their 0.994% as on every market.</li>
      <li><strong>The vault keeps its SOL.</strong> The vault&apos;s SOL and tokens are never paid out to anyone; agents trade it within fixed on-chain limits.</li>
      <li><strong>Most bundles earn little.</strong> At today&apos;s volume the median bundle in our simulation earned about 0.017 SOL of fees over its first days;
        one market in 52 earned 3.8 SOL.</li>
      <li><strong>Refunds if it fails.</strong> A raise that misses its target by the deadline returns every deposit in full.</li>
    </ul>
  </div>
}

// Opening the raise from the form: check the target, have the wallet sign the bundle's creation, then go to its raise page.
// ready: the token details are complete. Returns the form's submit handler and its progress.
export function useOpenBundle({ repo, settings, token, raise, ready }) {
  const { wallet, connect, provider } = useWallet()
  const [stage, setStage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const working = useRef(false)
  async function open(event) {
    event.preventDefault()
    if (working.current || !ready) return
    working.current = true; setBusy(true); setError('')
    try {
      let target
      try { target = BigInt(parseUnits(raise.target.trim(), 9)) } catch { target = -1n }
      if (target < BigInt(settings.minTargetLamports) || target > BigInt(settings.maxTargetLamports)) {
        throw new Error(`Choose a target from ${sol(settings.minTargetLamports)} to ${sol(settings.maxTargetLamports)} SOL.`)
      }
      const address = wallet || await connect()
      const opened = await openBundle({ repoId: repo.repoId, launcherWallet: address, tokenName: token.name, tokenSymbol: token.symbol,
        tokenImage: token.image, targetLamports: target.toString(), deadlineDays: raise.days }, { provider, onStage: setStage })
      setStage('Opened')
      window.location.assign(`/bundle/${opened.bundleId}`)
    } catch (cause) { setError(cause.message || 'Could not open the bundle.'); setStage('') }
    finally { working.current = false; setBusy(false) }
  }
  return { open, stage, error, busy }
}

export function BundleOpenButton({ opening, disabled }) {
  return <>
    <button type="submit" className="button primary launch-submit" disabled={disabled || opening.busy}>{opening.busy ? opening.stage || 'Opening…' : 'Open bundle'}</button>
    <p className="form-fineprint">Opening costs the bundle account&apos;s rent and the network fee. You approve it in your wallet.</p>
    <TransactionStatus stage={opening.busy ? opening.stage : ''} error={opening.error}/>
  </>
}
