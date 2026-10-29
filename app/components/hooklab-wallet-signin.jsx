'use client'
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { useWallet } from './wallet'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { validateWalletIdentityChallenge, walletIdentitySessionState } from '../lib/hooklab-wallet-identity-client.mjs'
import { NeuronBotCheck } from './neuron-bot-check'
const endpoint = '/api/hook-lab/wallet-identity'
async function call(body, botToken) {
  const response = await fetch(endpoint, { cache: 'no-store', credentials: 'same-origin',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...(botToken ? { 'x-neuron-bot-token': botToken } : {}) }, body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw Error(value.error || 'Wallet sign-in is unavailable.')
  return value
}
export const shortAddress = address => address ? `${address.slice(0, 4)}…${address.slice(-4)}` : ''

// The Hooks wallet session: proves wallet control with one signed message (no transaction). enabled: false
// skips the session check, for a caller that was handed another instance's session.
export function useHookWalletSession(genesisHash, { enabled = true } = {}) {
  const { wallet, connect, provider } = useWallet()
  const walletRef = useRef(wallet); walletRef.current = wallet
  const busyRef = useRef(false), sessionEpoch = useRef(0)
  const botCheckRef = useRef(null), [botSiteKey, setBotSiteKey] = useState(null)
  const [busy, setBusy] = useState(false), [identity, setIdentity] = useState(null), [error, setError] = useState('')
  const [checked, setChecked] = useState(!enabled)
  useEffect(() => {
    if (!enabled) return
    let active = true
    const epoch = sessionEpoch.current
    call().then(value => { if (active && sessionEpoch.current === epoch) { setIdentity(walletIdentitySessionState(value)); setBotSiteKey(value.botSiteKey ?? null) } })
      // A failed background check just reads as signed out: signing in reports its own errors.
      .catch(() => { if (active && sessionEpoch.current === epoch) setIdentity(null) })
      .finally(() => { if (active) setChecked(true) })
    return () => { active = false }
  }, [enabled])
  useEffect(() => {
    if (!identity) return
    const remaining = Date.parse(identity.expiresAt) - Date.now()
    if (remaining <= 0) { setIdentity(null); return }
    const timer = setTimeout(() => setIdentity(null), remaining)
    return () => clearTimeout(timer)
  }, [identity])
  // Resolves true when the action finished, false when it failed (the error is shown) or another was running.
  const run = async action => {
    if (busyRef.current) return false
    sessionEpoch.current += 1
    busyRef.current = true; setBusy(true); setError('')
    try { await action(); return true } catch (cause) { setError(cause.message || 'Sign-in could not finish. Try again.'); return false }
    finally { busyRef.current = false; setBusy(false) }
  }
  // One click: connect if needed, fetch the challenge, check it is ours, and ask the wallet to sign it.
  const signIn = () => run(async () => {
    const address = walletRef.current || await connect()
    const changed = () => walletRef.current && walletRef.current !== address
    if (botSiteKey && !botCheckRef.current) throw Error('Security check is loading. Please try again.')
    const botToken = botSiteKey ? await botCheckRef.current() : null
    const value = await call({ action: 'challenge', wallet: address }, botToken)
    if (changed()) throw Error('Connected wallet changed. Start again.')
    const reviewed = validateWalletIdentityChallenge(value.challenge, { wallet: address, origin: window.location.origin, genesisHash })
    const adapter = provider()
    if (typeof adapter?.signMessage !== 'function') throw Error('This wallet cannot sign messages. Try Phantom, Solflare or Backpack.')
    const bytes = walletSignatureBytes(await adapter.signMessage(new TextEncoder().encode(reviewed.message)))
    if (walletRef.current !== address) throw Error('Connected wallet changed. Start again.')
    validateWalletIdentityChallenge(reviewed, { wallet: address, origin: window.location.origin, genesisHash })
    const verified = await call({ action: 'verify', wallet: address, nonce: reviewed.nonce, signature: btoa(String.fromCharCode(...bytes)) })
    setIdentity(walletIdentitySessionState(verified))
  })
  const signOut = () => run(async () => { await call({ action: 'logout' }); setIdentity(null) })
  const mismatch = !!(identity && wallet && identity.wallet !== wallet)
  const connectWallet = () => run(async () => { await connect() })
  return { identity, wallet, busy, error, checked, mismatch, signedIn: !!identity && !mismatch, signIn, signOut, connectWallet, botSiteKey, botCheckRef }
}

// Sign-in card. session: an existing useHookWalletSession result to show instead of starting another.
export function HookWalletSignIn({ genesisHash, onIdentity, session: shared = null, title = 'Sign in with your wallet', children }) {
  const own = useHookWalletSession(genesisHash, { enabled: !shared })
  const session = shared ?? own
  const { identity, wallet, busy, error, checked, mismatch, signIn, signOut, connectWallet } = session
  useEffect(() => { onIdentity?.(identity) }, [identity, onIdentity])
  return <section className="inner-card hooks-signin" aria-live="polite">
    {identity ? <div className="hooks-signin-row"><CheckCircle2 size={18} aria-hidden="true"/><span>Signed in as <code title={identity.wallet}>{shortAddress(identity.wallet)}</code></span>
      {!wallet && <button type="button" className="button primary" disabled={busy} onClick={connectWallet}>{busy ? 'Check your wallet…' : 'Connect this wallet'}</button>}
      <button type="button" className="button outline" disabled={busy} onClick={signOut}>Sign out</button></div>
      : <><h3>{title}</h3><p>{children ?? 'Your wallet shows a short sign-in message. Signing it is free and sends no transaction.'}</p>
        <button type="button" className="button primary" disabled={busy || !checked} onClick={signIn}>{busy ? 'Check your wallet…' : wallet ? 'Sign in with wallet' : 'Connect wallet and sign in'}</button></>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {mismatch && <p className="inline-error" role="alert">This session belongs to {shortAddress(identity.wallet)}. Sign out, then sign in with the wallet you have connected.</p>}
    {session.botSiteKey && <NeuronBotCheck siteKey={session.botSiteKey} action="neuron-signin" checkRef={session.botCheckRef}/>}
  </section>
}
