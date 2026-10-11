'use client'
import { useEffect, useState } from 'react'
import { money } from './credit-packs/packs-model.mjs'
import '../pack-shares.css'

// Claim page: a repository's unclaimed pack shares (app/api/credits/shares/[repo]/route.js) for its payout wallet holder, claimed
// as AI credits on their repo.ing AI credits account. Only a click claims. Any answer but a good one (not found, rate limited,
// unreachable) shows nothing.
export function PackSharesClaim({ repoId }) {
  const [shares, setShares] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [claimed, setClaimed] = useState(null)
  useEffect(() => {
    let live = true
    fetch(`/api/credits/shares/${repoId}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(value => { if (live && value?.repoId === String(repoId)) setShares(value) })
      .catch(() => {})
    return () => { live = false }
  }, [repoId])
  async function claim() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/credits/shares/${repoId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim' }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The claim could not be completed. Try again.')
      if (!/^\d+$/.test(body.claimedMicro ?? '')) throw new Error('The claim could not be completed. Try again.')
      setClaimed(body.claimedMicro)
    } catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  const waiting = shares?.holder && /^\d+$/.test(shares.unclaimedMicro ?? '') ? BigInt(shares.unclaimedMicro) : 0n
  if (claimed === null && waiting === 0n) return null
  // An answer of 0 is not "never paid": a retry after a lost answer answers 0 too.
  return <section className="inner-card pack-shares-claim" aria-labelledby="pack-shares-claim-title">
    <h2 id="pack-shares-claim-title">{claimed === null ? `Pack shares: ${money(waiting.toString())} in AI credits` : 'Pack shares'}</h2>
    {claimed === null && <p className="pack-shares-note">Buyers opened AI credit packs for {shares.fullName}. {shares.shareBps / 100}% of each pack is set aside for its builders. Claiming adds it to your repo.ing AI credits.</p>}
    {claimed === null && <button type="button" className="button primary" disabled={busy} onClick={claim}>{busy ? 'Claiming…' : 'Claim as AI credits'}</button>}
    {claimed !== null && <p role="status" className="pack-shares-done">{BigInt(claimed) > 0n ? `Added ${money(claimed)} to your repo.ing AI credits.` : 'Nothing new to claim.'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}
