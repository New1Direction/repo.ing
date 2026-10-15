'use client'
import { useState } from 'react'

export function HookLabAcceptance({ identity }) {
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  const [recovery, setRecovery] = useState(null), [error, setError] = useState('')
  async function recover() {
    setBusy(true); setRecovery(null); setError('')
    try {
      const response = await fetch('/api/hook-lab/acceptance?confirmedNetwork=devnet', { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Recovery unavailable. Do not relaunch.')
      setRecovery(result.recovery)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  return <div className="coin-workspace">
    <section><h2>One retained mint. No retry launch.</h2>
      <p className="coin-note">This is the owner-authorized disposable-wallet acceptance, not a public wallet launch flow.
        Reloading this page preserves the same public mint and signature. No keys or signing controls are present.</p>
      <dl className="coin-terms">
        <div><dt>Mint · custom Hook Lab token</dt><dd><code>{identity.mint}</code>Not SPL or Token-2022.</dd></div>
        <div><dt>Fresh swap program</dt><dd><code>{identity.swap}</code></dd></div>
        <div><dt>Fresh launch program</dt><dd><code>{identity.launch}</code></dd></div>
        <div><dt>Reviewed message SHA-256</dt><dd><code>{identity.messageSha256}</code></dd></div>
        <div><dt>Finalized acceptance signature</dt><dd><a href={`https://explorer.solana.com/tx/${identity.signature}?cluster=devnet`} target="_blank" rel="noreferrer">View devnet transaction ↗</a><code>{identity.signature}</code></dd></div>
      </dl>
    </section>
    <aside className="coin-review" aria-label="Devnet acceptance recovery">
      <h2>Verify recovery</h2>
      <p className="coin-note">Recorded finality: slot {identity.finalizedSlot}. Read current finalized native accounts and verify the receipt again.
        This does not certify current program code or authorize another launch.</p>
      <label className="coin-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>
        <span>I confirm Solana devnet for read-only recovery. No signing or spending.</span></label>
      <button className="button primary" disabled={!confirmed || busy} onClick={recover}>{busy ? 'Reading finalized state…' : 'Verify retained HLTEST'}</button>
      <p role="status" aria-live="polite" className="coin-status">{busy ? 'Checking receipt and native token balances…' : recovery?.status === 'finalized'
        ? `Verified finalized receipt · slot ${recovery.finalizedSlot}. State observed at slot ${recovery.observedSlot}.`
        : recovery ? 'No finalized receipt available. Unresolved: preserve the same mint; never relaunch.' : 'Live recovery not checked in this browser.'}</p>
      {error && <p role="alert" className="coin-error">{error}</p>}
      {recovery?.status === 'finalized' && <><dl>
        <div><dt>Total debit</dt><dd>0.032870000 devnet SOL</dd></div>
        <div><dt>Launch fee / rent</dt><dd>0.010000000 / 0.022860000 SOL</dd></div>
        <div><dt>Network / priority fee</dt><dd>0.000010000 / 0 SOL</dd></div>
        <div><dt>Supply · 6 decimals</dt><dd>1,000,000,000 HLTEST</dd></div>
        <div><dt>Curve / reserve</dt><dd>75% / 25%</dd></div>
        <div><dt>Real quote / LP supply</dt><dd>0 / 0</dd></div>
        <div><dt>Swaps / optional rules</dt><dd>0 / none</dd></div>
      </dl><p className="coin-note">Mint, metadata, freeze and hook authorities are absent. Empty LP holding belongs to the launch PDA; no LP burn or external lock is claimed.
        Virtual quote is curve math, not deposited SOL. Programs remain upgradeable and config admin retains broad powers.</p></>}
      <p className="coin-note">Public execution, legacy fallback, Kit, templates, trading, bridge execution and mainnet remain disabled.</p>
    </aside>
  </div>
}
