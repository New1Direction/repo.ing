'use client'

import { useState } from 'react'

const SYMBOLS = results => results.map(r => r.symbol).filter(Boolean)

// "Claim tips": the tip wallet pays every confirmed tip to the reviewed payout wallet, one transfer per token.
// The server re-checks GitHub admin access and the payout wallet before anything is signed.
export function ClaimTips({ review, symbols = {}, compact = false }) {
  const [busy, setBusy] = useState(false), [results, setResults] = useState(null), [error, setError] = useState('')
  async function claim() {
    if (busy || !review) return
    setBusy(true); setError(''); setResults(null)
    try {
      const response = await fetch('/api/tips/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ review }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Tip claim could not finish. Refresh and try again.')
      setResults(body.results.map(r => ({ ...r, symbol: symbols[r.mint] ?? '' })))
    } catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  const sent = results?.filter(r => r.status !== 'failed') ?? []
  return <div className={`claim-tips${compact ? ' compact' : ''}`}>
    {!(results && results.every(r => r.status !== 'failed')) && <button type="button" className={`button ${compact ? 'outline' : 'primary'}`} disabled={busy || !review} onClick={claim}>{busy ? 'Claiming tips…' : 'Claim tips'}</button>}
    {busy && !compact && <small role="status">Checking GitHub access and sending each token to your payout wallet. Keep this page open.</small>}
    {results && <ul className="claim-tips-results" role="status">{results.map(r => <li key={r.mint}>
      {r.status === 'failed' ? <span className="inline-error">{r.symbol} {r.error}</span>
        : <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noopener noreferrer">{r.symbol} {r.status === 'settled' ? 'paid' : 'sent, confirming'} ↗</a>}</li>)}</ul>}
    {results && !compact && sent.length > 0 && <small>{SYMBOLS(sent).join(', ')} tips sent to your payout wallet. Refresh to see updated totals.</small>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}
