'use client'
import { useCallback, useEffect, useState } from 'react'
import { useWallet } from './wallet'
import { XMark } from './x-mark'
import { XHandleLink } from './x-handle-link'
import { xLinkChanged } from './x-link-state'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { shortWallet } from '../lib/holder-note-format.mjs'

const RETURN = { cancelled: 'X sign-in was cancelled. Nothing was linked.', expired: 'X sign-in expired. Connect X again.',
  'rate-limited': 'Too many attempts. Try again in a few minutes.', invalid: 'X sign-in could not be verified. Connect X again.',
  failed: 'X sign-in could not be completed. Try again.' }
const WARNING = 'This publicly links this wallet to your X account.'

async function call(url, init) {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'X linking is temporarily unavailable.')
  return result
}
const post = body => call('/api/x/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const encode = bytes => btoa(String.fromCharCode(...bytes))
const day = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function Profile({ link, trust }) {
  return <div className="x-account-profile">
    {link.image ? <img src={link.image} alt="" width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer"/> : <span className="x-account-avatar" aria-hidden="true"><XMark size={16}/></span>}
    <div><XHandleLink link={link} trust={trust}/>{link.name && <span className="x-account-name">{link.name}</span>}</div>
  </div>
}

// /wallet: optional Connect X. X proves the account (read-only OAuth); a free wallet signature proves the wallet.
export function XAccount() {
  const { wallet, provider } = useWallet()
  const [state, setState] = useState(null), [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!wallet) { setState(null); return }
    try { setState(await call(`/api/x/link?wallet=${encodeURIComponent(wallet)}`)) } catch (cause) { setState({ link: null, pending: null }); setError(cause.message) }
  }, [wallet])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const url = new URL(window.location.href), code = url.searchParams.get('x')
    if (!code) return
    if (RETURN[code]) setError(RETURN[code])
    url.searchParams.delete('x')
    window.history.replaceState(null, '', url)
  }, [])

  async function run(kind, task) {
    if (busy) return
    setBusy(kind); setError(''); setNotice('')
    try { await task() } catch (cause) { setError(cause.message || 'X linking failed.'); setNotice('') } finally { setBusy('') }
  }
  const sign = async message => {
    setNotice('Approve the message in your wallet. It does not send a transaction.')
    return encode(walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(message))))
  }
  const connectX = () => run('connect', async () => {
    const { url } = await call('/api/x/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }) })
    setNotice('Opening X…')
    window.location.assign(url)
  })
  const confirm = () => run('confirm', async () => {
    const signature = await sign(state.pending.message)
    const { link } = await post({ action: 'confirm', signature })
    setState({ link, pending: null }); setNotice(`Linked @${link.username} to this wallet.`)
    xLinkChanged(wallet, link)
  })
  const cancel = () => run('cancel', async () => { await post({ action: 'cancel' }); setState(current => ({ ...current, pending: null })) })
  const unlink = () => run('unlink', async () => {
    const challenge = await post({ action: 'unlink-challenge', wallet })
    await post({ action: 'unlink', challenge: challenge.challenge, signature: await sign(challenge.message) })
    setState(current => ({ ...current, link: null })); setNotice('X account unlinked from this wallet.')
    xLinkChanged(wallet, null)
  })

  if (!wallet) return null
  const { link, pending } = state ?? {}
  const pendingHere = pending && pending.wallet === wallet
  return <section id="x-account" className="inner-card x-account" aria-labelledby="x-account-title" aria-busy={!state}>
    <div className="x-account-head"><span className="x-account-mark" aria-hidden="true"><XMark size={15}/></span>
      <div><h2 id="x-account-title">X account <small>Optional</small></h2><p>Show your @handle next to this wallet on holder notes, tips and payouts.</p></div></div>
    {!state ? <p className="x-account-status" role="status">Checking…</p>
      : pending ? <div className="x-account-pending">
        <Profile link={pending}/>
        <p className="x-account-warning" role="note"><strong>{WARNING}</strong> Anyone can see @{pending.username} next to {shortWallet(pending.wallet)}. You can unlink any time.</p>
        {pendingHere ? <div className="x-account-actions"><button type="button" className="button primary" disabled={Boolean(busy)} onClick={confirm}>{busy === 'confirm' ? 'Signing…' : 'Sign to link'}</button>
          <button type="button" className="button outline" disabled={Boolean(busy)} onClick={cancel}>Cancel</button></div>
          : <div className="x-account-actions"><p className="x-account-status">Switch your wallet to {shortWallet(pending.wallet)} to finish, or cancel.</p>
            <button type="button" className="button outline" disabled={Boolean(busy)} onClick={cancel}>Cancel</button></div>}
      </div>
      : link ? <div className="x-account-linked">
        <Profile link={link}/>
        <span className="x-account-since">{link.linkedAt ? `Linked ${day(link.linkedAt)}` : 'Linked'}</span>
        <button type="button" className="button outline" disabled={Boolean(busy)} onClick={unlink}>{busy === 'unlink' ? 'Signing…' : 'Unlink'}</button>
      </div>
      : confirming ? <div className="x-account-confirm">
        <p className="x-account-warning" role="note"><strong>{WARNING}</strong> Your @handle and X profile picture appear next to this wallet for everyone. repo.ing asks X for read-only access, never posts, and keeps no X tokens. After X, you sign a free message to prove this wallet. Unlink any time.</p>
        <div className="x-account-actions"><button type="button" className="button primary" disabled={Boolean(busy)} onClick={connectX}><XMark size={14}/>{busy === 'connect' ? 'Opening X…' : 'Continue to X'}</button>
          <button type="button" className="button outline" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>Not now</button></div>
      </div>
      : <div className="x-account-actions"><button type="button" className="button outline x-account-connect" onClick={() => { setConfirming(true); setError('') }}><XMark size={14}/>Connect X</button></div>}
    {notice && <p className="transaction-status" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}
