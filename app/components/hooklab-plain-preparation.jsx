'use client'

import { useEffect, useState } from 'react'
import { useWallet } from './wallet'

export function HookLabPlainPreparation({ packet }) {
  const { wallet, connect, disconnect } = useWallet()
  const [confirmed, setConfirmed] = useState(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setConfirmed(false); setStatus('') }, [wallet])
  async function inspect() {
    if (!wallet || !confirmed) { setStatus('Connect a wallet and confirm the intended network. Connection is not a creator grant.'); return }
    setBusy(true)
    try {
      const response = await fetch('/api/hook-lab/production', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'simulate', confirmedNetwork: 'mainnet-beta' }) })
      // No returned field can enable signing. The deployment/approval gate remains in code.
      setStatus(response.status === 423 ? 'Simulation refused: production deployment, creator grant and launch approval are not bound. No wallet signature or transaction was requested.'
        : 'Unexpected readiness response. Stop and retain the current state; signing remains disabled.')
    } catch { setStatus('Readiness service unavailable. No transaction was signed or sent. Retry inspection only; never replace a pending launch.') }
    finally { setBusy(false) }
  }
  return <section className="coin-entry-points" aria-labelledby="plain-preparation"><div>
    <h2 id="plain-preparation">Plain launch preparation</h2>
    <p>Connecting shares a public address only. It does not select the approved creator, authorize spending or change production readiness.</p>
    {wallet ? <><p data-testid="plain-connected">Connected address <code>{wallet}</code></p>
      <button className="button" type="button" onClick={() => { void disconnect() }}>Disconnect preparation wallet</button></>
      : <button className="button" type="button" onClick={() => { void connect().catch(() => setStatus('Wallet connection cancelled. No signature requested.')) }}>Connect preparation wallet</button>}
    <label className="coin-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>
      I understand this is intended for Solana mainnet-beta, not the finalized devnet HLTEST launch.</label>
    <div className="coin-actions">
      <button className="button" type="button" disabled={busy} onClick={inspect}>{busy ? 'Checking…' : 'Check simulation readiness'}</button>
      <button className="button" type="button" disabled>Review exact transaction — unavailable</button>
      <button className="button" type="button" disabled>Sign and submit — disabled</button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
    <dl className="coin-terms">
      <div><dt>Creator and instruction payer</dt><dd>Not selected. The creator pays account rent and program fees. The outer transaction fee payer pays network and priority fees; these may be different wallets.</dd></div>
      <div><dt>Owner decisions still required</dt><dd>Creator public key, metadata, mint custody, economics, grant lifetime cap and exclusive expiry, creation deadline, exact rent and fee budget. No connected wallet is substituted.</dd></div>
      <div><dt>What creation does</dt><dd>Creates the token and pool, mints supply and deposits the base allocation into a curve. There is no initial buy or quote liquidity seeding; trading can remain paused.</dd></div>
      <div><dt>Recovery and monitoring</dt><dd>No production journal is active. Retain the exact message, signature and mint after any future signing. A missing receipt stays unresolved; a later outage never erases retained finalized evidence. No automatic retry or new-mint recovery is offered.</dd></div>
    </dl>
    <details><summary>Proposed source identities — not deployed or adopted</summary>
      <p>Source {packet.sourceCommit}. Active profile: none.</p>
      {Object.entries(packet.proposedPrograms).map(([role, address]) => <p key={role}>{role}<code>{address}</code></p>)}
      <p>Network genesis<code>{packet.genesisHash}</code></p>
      <p>Profile SHA256<code>{packet.profileSha256}</code></p>
    </details>
  </div></section>
}

// Recovery is GitHub-owner scoped, independent of wallet connection or creator-grant expiry.
// No response, wallet, query string or local storage value can enable a transaction action.
export function HookLabProductionAccount() {
  const [account, setAccount] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function refresh() {
    setBusy(true); setError(''); setAccount(null)
    try {
      const response = await fetch('/api/hook-lab/production/account', { cache: 'no-store' })
      const result = await response.json()
      if (response.status === 401) setAccount({ signedIn: false })
      else if (!response.ok) setError(result.error || 'Recovery unavailable. Preserve the original message, mint and signature.')
      else setAccount(result)
    } catch { setError('Recovery service unavailable. Preserve the original message, mint and signature; do not retry a launch.') }
    finally { setBusy(false) }
  }
  return <section className="coin-entry-points" aria-labelledby="production-account"><div>
    <h2 id="production-account">Your retained operations</h2>
    <p>Sign in with GitHub to read your recovery journal after its separate service rollout. Wallet connection is not authentication. This account view cannot prepare, sign, submit or retry a transaction.</p>
    <div className="coin-actions">
      <a className="button" href="/api/github/start?mode=hooklab-production">Sign in with GitHub</a>
      <button className="button" type="button" disabled={busy} onClick={refresh}>{busy ? 'Reading…' : 'Refresh retained operations'}</button>
    </div>
    <div aria-live="polite" aria-busy={busy}>
      {error && <p role="alert" className="coin-error">{error}</p>}
      {account?.signedIn === false && <p>Sign in with GitHub first. No wallet signature is needed to read retained operations.</p>}
      {account?.signedIn && <>
        <p>Signed in as {account.githubLogin}. {account.status === 'disabled' ? account.error : 'Read-only recovery. Deployment adoption and all execution remain disabled.'}</p>
        {account.evidence && <p>Account evidence: {account.evidence.status}. {account.evidence.reason} Policy and provenance acceptance remain unverified.</p>}
        {account.status === 'read-only' && !account.entries.length && <p>No retained operations for this account. This is not evidence that a transaction was never submitted elsewhere.</p>}
        {account.entries?.length > 0 && <>
          <p>Latest {account.entries.length} of up to 50 entries. Receipt retention is not production acceptance. A later outage never authorizes a replacement launch.</p>
          <ul className="coin-history">{account.entries.map(entry => <li key={entry.id}>
            <details><summary>Operation {entry.id} · {entry.status}</summary>
              <p>Mint<code>{entry.mint}</code>Message SHA256<code>{entry.messageSha256}</code></p>
              <p>Original signature<code>{entry.signature || 'No fully signed transaction retained'}</code></p>
              <p>First finalized evidence: {entry.receiptRetained ? 'retained, not accepted production evidence' : 'not retained'}. Chain operation verified: no. Retry disabled.</p>
            </details>
          </li>)}</ul>
        </>}
      </>}
    </div>
    <p>External partial-signature backup and historical post-operation acceptance are not implemented here. Emergency pause must never wait for receipt acceptance.</p>
  </div></section>
}
