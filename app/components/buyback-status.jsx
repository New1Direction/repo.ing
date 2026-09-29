import { formatSolDisplay } from '../lib/format.mjs'
import { formatAgo, formatTokenCompact } from '../lib/buyback-summary.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'

export const BUYBACK_NOTE = 'Buybacks are executed manually by the team; every one is published here with its on-chain receipt.'
export const receiptUrl = signature => `https://explorer.solana.com/tx/${signature}`

export function LastBuybackTime({ last, now }) {
  return <time dateTime={last.at} title={`${new Date(last.at).toUTCString()}`}>{formatAgo(last.at, now)}</time>
}

// What the fees-since figure is, in words that match how it was computed.
export function feesSinceLabel(since, hasLast) {
  const when = hasLast ? 'since the last buyback' : 'so far'
  return since.basis === 'policy' ? `Allocated to buybacks ${when}` : `Platform fees collected ${when}`
}

// /stats: last platform-revenue buyback, fees since it, and how buybacks happen.
export function BuybackStatus({ status, now = Date.now() }) {
  const last = status?.last ?? null, since = status?.since ?? null
  return <section className="analytics-revenue buyback-status" aria-labelledby="buyback-status-title">
    <div className="analytics-section-heading"><div><h2 id="buyback-status-title">Buyback status</h2><p>{BUYBACK_NOTE}</p></div></div>
    <div className="analytics-reserves buyback-status-grid">
      <div><span>Last platform-revenue buyback</span>{last
        ? <><strong><LastBuybackTime last={last} now={now}/></strong><small>{formatSolDisplay(last.spentLamports)} SOL spent · {formatTokenCompact(last.tokenBaseUnits)} ${OFFICIAL_TOKEN.symbol} bought · <a href={receiptUrl(last.signature)} target="_blank" rel="noopener noreferrer">Receipt ↗</a></small></>
        : <><strong>None yet</strong><small>No platform-revenue buyback has been recorded.</small></>}</div>
      <div><span>{since ? feesSinceLabel(since, !!last) : 'Platform fees since the last buyback'}</span>{since
        ? <><strong>{formatSolDisplay(since.lamports)} SOL</strong><small>{since.basis === 'policy'
          ? `${since.permille / 10}% buyback share of ${formatSolDisplay(since.totalLamports)} SOL in claimed platform fees, under the revenue policy above`
          : 'Total claimed platform fees. No allocation policy is active, so no buyback share is applied.'}</small></>
        : <><strong>—</strong><small>Unavailable while platform accounting is being verified.</small></>}</div>
    </div>
    <p className="analytics-note">Ledger amounts from settled platform-fee claims, not a wallet balance or a commitment to buy.</p>
  </section>
}
