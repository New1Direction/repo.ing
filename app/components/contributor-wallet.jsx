'use client'
import { useCallback, useEffect, useState } from 'react'
import { CopyAddress } from './copy-address'
import { GithubMark } from './github-mark'
import { useWallet } from './wallet'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { shortWallet } from '../lib/holder-note-format.mjs'
import '../contributor-wallet.css'

const SIGN_IN = '/api/github/start?mode=contributor'
const UNAVAILABLE = 'Wallet linking is temporarily unavailable. Try again.'

class ApiError extends Error { constructor(message, status) { super(message); this.status = status } }
async function call(path, init) {
  const response = await fetch(path, { cache: 'no-store', ...init })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(body.error || UNAVAILABLE, response.status)
  return body
}
const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const encode = bytes => btoa(String.fromCharCode(...bytes))
const day = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// /contributors/link: GitHub sign-in (identity only), then the wallet signs a free message to become the account's
// contributor wallet. One wallet per account; linking another replaces it.
export function ContributorWallet({ signedIn, githubLogin, errorCode }) {
  const { wallet, connect, provider } = useWallet()
  const [state, setState] = useState(null), [needsSignIn, setNeedsSignIn] = useState(!signedIn)
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState(errorCode ? 'GitHub sign-in could not finish. Try again.' : '')

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const body = await call('/api/contributor-wallet')
      setError('')
      if (body.signedIn) setState(body); else setNeedsSignIn(true)
    } catch (cause) { setLoadFailed(true); setError(cause.message) }
  }, [])
  useEffect(() => { if (signedIn) void load() }, [signedIn, load])
  // The sign-in's ?verified / ?error are read once (errorCode), then dropped from the address bar.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('verified') && !url.searchParams.has('error')) return
    url.searchParams.delete('verified'); url.searchParams.delete('error')
    window.history.replaceState(null, '', url)
  }, [])

  async function run(kind, task) {
    if (busy) return
    setBusy(kind); setError(''); setNotice('')
    try { await task() } catch (cause) {
      if (cause.status === 401) setNeedsSignIn(true)
      setNotice(''); setError(cause.message || UNAVAILABLE)
    } finally { setBusy('') }
  }
  const linkWallet = () => run('link', async () => {
    const address = wallet || await connect()
    const challenge = await post('/api/contributor-wallet/challenge', { wallet: address })
    setNotice('Approve the message in your wallet. It is free and sends no transaction.')
    const signature = encode(walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(challenge.message))))
    const { link } = await post('/api/contributor-wallet/link', { wallet: challenge.wallet, nonce: challenge.nonce, signature })
    setState(current => ({ ...current, link })); setNotice(`Linked ${shortWallet(link.wallet)} to ${link.githubLogin}.`)
  })
  const unlink = () => run('unlink', async () => {
    await call('/api/contributor-wallet', { method: 'DELETE' })
    setState(current => ({ ...current, link: null })); setNotice('Wallet unlinked.')
  })

  if (needsSignIn) return <section className="contributor-wallet inner-card" aria-labelledby="contributor-signin-title">
    {error && <p className="inline-error" role="alert">{error}</p>}
    <h2 id="contributor-signin-title">Sign in with GitHub</h2>
    <p>repo.ing learns which GitHub account you are. It gets no access to your code.</p>
    <a className="button primary" href={SIGN_IN}><GithubMark size={18}/>Sign in with GitHub</a>
  </section>

  const link = state?.link ?? null
  const canLink = Boolean(wallet) && wallet !== link?.wallet
  return <section className="contributor-wallet inner-card" aria-labelledby="contributor-wallet-title" aria-busy={!state}>
    <div className="contributor-wallet-account"><span><GithubMark size={17}/>{state?.githubLogin || githubLogin}</span><a href={SIGN_IN}>Switch account</a></div>
    <h2 id="contributor-wallet-title">Your contributor wallet</h2>
    {!state ? loadFailed ? <button type="button" className="button outline" onClick={() => void load()}>Try again</button>
      : <p className="contributor-wallet-status" role="status">Checking…</p>
      : link ? <div className="contributor-wallet-linked"><CopyAddress address={link.wallet} label="linked wallet"/><span>Linked {day(link.linkedAt)}</span></div>
        : <p className="contributor-wallet-status">No wallet linked yet.</p>}
    {state && <div className="contributor-wallet-actions">
      {!wallet && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => run('connect', connect)}>{busy === 'connect' ? 'Connecting…' : 'Connect wallet'}</button>}
      {canLink && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={linkWallet}>
        {busy === 'link' ? 'Signing…' : link ? `Link ${shortWallet(wallet)} instead` : `Sign to link ${shortWallet(wallet)}`}</button>}
      {link && <button type="button" className="button outline" disabled={Boolean(busy)} onClick={unlink}>{busy === 'unlink' ? 'Unlinking…' : 'Unlink'}</button>}
    </div>}
    <p className="contributor-wallet-note">One wallet per GitHub account. Linking another wallet replaces it.</p>
    {notice && <p className="transaction-status" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}
