'use client'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from './wallet'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { validateWalletIdentityChallenge, walletIdentitySessionState } from '../lib/hooklab-wallet-identity-client.mjs'
const endpoint = '/api/hook-lab/wallet-identity'
async function call(body) {
  const response = await fetch(endpoint, { cache: 'no-store', credentials: 'same-origin',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw Error(value.error || 'Wallet sign-in is unavailable.')
  return value
}
export function HookWalletSignIn({ genesisHash, onIdentity }) {
  const { wallet, connect, provider } = useWallet()
  const walletRef = useRef(wallet); walletRef.current = wallet
  const busyRef = useRef(false), sessionEpoch = useRef(0)
  const [busy, setBusy] = useState(false), [challenge, setChallenge] = useState(null)
  const [identity, setIdentity] = useState(null), [error, setError] = useState('')
  useEffect(() => { setChallenge(null) }, [wallet])
  useEffect(() => { onIdentity?.(identity) }, [identity, onIdentity])
  useEffect(() => {
    let active = true
    const epoch = sessionEpoch.current
    call().then(value => { if (active && sessionEpoch.current === epoch) setIdentity(walletIdentitySessionState(value)) })
      .catch(() => { if (active && sessionEpoch.current === epoch) { setIdentity(null); setError('Could not check your current session. Try signing in again.') } })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!identity) return
    const remaining = Date.parse(identity.expiresAt) - Date.now()
    if (remaining <= 0) { setIdentity(null); return }
    const timer = setTimeout(() => setIdentity(null), remaining)
    return () => clearTimeout(timer)
  }, [identity])
  const run = async action => {
    if (busyRef.current) return
    sessionEpoch.current += 1
    busyRef.current = true; setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause.message || 'Sign-in could not finish. Start again.'); setChallenge(null) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const review = () => run(async () => {
    const address = wallet || await connect()
    const value = await call({ action: 'challenge', wallet: address })
    if (walletRef.current && walletRef.current !== address) throw Error('Connected wallet changed. Start again.')
    setChallenge(validateWalletIdentityChallenge(value.challenge, { wallet: address, origin: window.location.origin, genesisHash }))
  })
  const signIn = () => run(async () => {
    const address = walletRef.current
    const reviewed = validateWalletIdentityChallenge(challenge, { wallet: address, origin: window.location.origin, genesisHash })
    const adapter = provider()
    if (typeof adapter?.signMessage !== 'function') throw Error('This wallet does not support message signing. Use a compatible wallet.')
    const bytes = walletSignatureBytes(await adapter.signMessage(new TextEncoder().encode(reviewed.message)))
    if (walletRef.current !== address) throw Error('Connected wallet changed. Start again.')
    validateWalletIdentityChallenge(reviewed, { wallet: address, origin: window.location.origin, genesisHash })
    const value = await call({ action: 'verify', wallet: address, nonce: reviewed.nonce, signature: btoa(String.fromCharCode(...bytes)) })
    setIdentity(walletIdentitySessionState(value)); setChallenge(null)
  })
  return <section className="inner-card">
    <h2>Sign in with your wallet</h2>
    <p>GitHub is optional. This message proves wallet control for this launcher. It sends no transaction and does not authorize a launch.</p>
    {identity ? <><p>Signed in as {identity.wallet}. Session expires {identity.expiresAt}.</p>
      <button disabled={busy} onClick={() => run(async () => { await call({ action: 'logout' }); setIdentity(null); setChallenge(null) })}>Sign out</button></>
      : <button disabled={busy} onClick={review}>{busy ? 'Working…' : 'Review sign-in message'}</button>}
    {challenge && <><p>Review the exact message before signing:</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{challenge.message}</pre>
      <button disabled={busy || !wallet || wallet !== challenge.wallet} onClick={signIn}>Sign this message</button>
      <button disabled={busy} onClick={() => setChallenge(null)}>Cancel</button></>}
    {error && <p role="alert">{error}</p>}
    {identity && wallet && identity.wallet !== wallet && <p role="alert">This session belongs to a different wallet. Sign out and sign in with your connected wallet before continuing.</p>}
  </section>
}
