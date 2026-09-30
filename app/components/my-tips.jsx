'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { useWallet } from './wallet'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'
import { formatTokenAmount } from '../lib/format.mjs'

const STATUS = { submitted: 'Confirming', confirmed: 'Waiting for maintainer', paid: 'Paid to maintainer', refunded: 'Refunded to you' }
const day = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// Tips sent from the connected wallet. After 90 days an unclaimed tip can be refunded: one signed message proves the
// wallet, and the tip wallet sends it back to this same wallet.
export function MyTips() {
  const { wallet, provider } = useWallet()
  const [tips, setTips] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(null), [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    if (!wallet) { setTips(null); return }
    try {
      const response = await fetch('/api/tips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'mine', wallet }) })
      const body = await response.json().catch(() => ({}))
      setTips(response.ok ? body.tips : null)
    } catch { setTips(null) }
  }, [wallet])
  useEffect(() => { void load() }, [load])

  async function refund(tip) {
    if (busy) return
    setBusy(tip.id); setError(''); setNotice('')
    const call = async body => {
      const response = await fetch('/api/tips/refund', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Refund could not finish. Try again.')
      return result
    }
    try {
      const challenge = await call({ action: 'challenge', wallet, tipIds: [tip.id] })
      setNotice('Approve the message in your wallet. It does not send a transaction.')
      const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(challenge.message)))
      setNotice('Sending your refund…')
      const { results } = await call({ action: 'refund', challenge: challenge.challenge, signature: btoa(String.fromCharCode(...signature)) })
      const failed = results.find(r => r.status === 'failed')
      if (failed) throw new Error(failed.error)
      setNotice(results[0]?.status === 'settled' ? 'Refund sent to your wallet.' : 'Refund sent; it is confirming.')
      await load()
    } catch (cause) { setError(cause.message || 'Refund could not finish.'); setNotice('') }
    finally { setBusy(null) }
  }

  if (!wallet || !tips?.length) return null
  return <section className="inner-card my-tips" aria-labelledby="my-tips-title">
    <h2 id="my-tips-title">Tips you sent</h2>
    <ul>{tips.map(tip => <li key={tip.id}>
      <div><strong>{formatTokenAmount(tip.amount, tip.decimals)} {tip.symbol}</strong>
        <span>to {tip.marketMint ? <Link href={`/token/${tip.marketMint}`}>{tip.fullName}</Link> : tip.fullName} · {day(tip.createdAt)}</span></div>
      <div className="my-tips-state"><span>{STATUS[tip.status] ?? tip.status}</span>
        {tip.refundable ? <button type="button" className="button outline" disabled={Boolean(busy)} onClick={() => refund(tip)}>{busy === tip.id ? 'Refunding…' : 'Refund'}</button>
          : tip.status === 'confirmed' && !tip.inFlight ? <small>Refundable from {day(tip.refundAfter)} if unclaimed</small> : null}
        {tip.signature && <a href={`https://solscan.io/tx/${tip.signature}`} target="_blank" rel="noopener noreferrer">Receipt ↗</a>}</div>
    </li>)}</ul>
    {notice && <p className="transaction-status" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}
