'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CopyAddress } from '../copy-address'

// Details → Rewards on a model market's token page (model-token-page.jsx rewardSections): the 1% builder allocation, the
// model counterpart of BuilderAllocation (app/components/builder-allocation.jsx), with the same states. Reserved from the
// fixed supply for the model's verified owner on Hugging Face: locked until graduation, then claimable once by that owner
// (here, with a review sealed for their Hugging Face session, or on /claim/<id>), then settled with the recipient and the
// receipt shown. The page around it carries the disclaimer; /api/allocation/<id> checks the model's current owner again.
const STATE_LABELS = { settled: 'Claimed', pending: 'Confirming', available: 'Unlocked', locked: 'Locked' }

export function ModelAllocation({ repoId }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const endpoint = `/api/allocation/${repoId}`
  async function refresh() {
    const response = await fetch(endpoint, { cache: 'no-store' })
    const next = await response.json()
    if (!response.ok) throw Error(next.error)
    setData(next); setError('')
  }
  useEffect(() => {
    let active = true, timer
    async function poll() {
      try { await refresh() } catch (cause) { if (active) setError(cause.message) }
      if (active) timer = setTimeout(poll, 10000)
    }
    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [endpoint])
  async function claim() {
    setBusy(true); setError('')
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ review: data.review }) })
      const result = await response.json()
      if (!response.ok) throw Error(result.error)
      setData(current => ({ ...current, state: result.status, receipt: result, review: null }))
    } catch (cause) { setError(cause.message) } finally { setBusy(false) }
  }
  if (data?.enrolled === false) return null
  const recipient = data?.receipt?.wallet ?? data?.wallet
  return <section className="inner-card builder-allocation model-allocation" aria-labelledby="model-allocation-title">
    <div className="card-heading"><h3 id="model-allocation-title">Builder allocation · 1%</h3><span className="small-chip">{STATE_LABELS[data?.state] ?? 'Checking'}</span></div>
    <strong>10,000,000 tokens</strong>
    <p>A one-time allocation from the fixed supply, reserved for the model’s verified owner on Hugging Face (the user, or an admin of the organization that owns it). Unlocks after graduation. Trading fees are separate.</p>
    {recipient && <div className="discovery-recipient"><span>{data?.state === 'settled' ? 'Paid to' : 'Saved payout wallet'}</span><CopyAddress address={recipient} label="allocation recipient"/></div>}
    {busy || data?.state === 'pending' ? <p className="claim-progress" role="status"><span className="claim-spinner"/>Checking Hugging Face ownership and confirming the token payout…</p>
      : data?.state === 'settled' ? <p className="positive" role="status">The 10 million token allocation was paid.</p>
        : data?.review ? <button className="button primary" type="button" onClick={claim}>Claim 10 million tokens</button>
          : data?.state === 'available' ? <Link className="button outline" href={`/claim/${repoId}`}>Sign in with Hugging Face &amp; set payout wallet</Link>
            : data?.state === 'locked' ? <p className="subtle-notice">The allocation stays reserved until this market graduates.</p>
              : <p role="status">Checking allocation…</p>}
    {data?.receipt?.signature && <a className="claim-text-button" href={`https://explorer.solana.com/tx/${data.receipt.signature}`} target="_blank" rel="noreferrer">View payout receipt ↗</a>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}
