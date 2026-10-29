import { formatSolDisplay } from '../lib/format.mjs'
import { formatAgo, formatTokenCompact } from '../lib/buyback-summary.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'

export const BUYBACK_NOTE = 'The team buys back by hand. Every buyback has an on-chain receipt.'
export const MISSION_NOTE = 'Platform fees fund $REPOING buybacks, protocol liquidity and the treasury under the published 60/20/20 policy. The team adds its own buybacks on top.'
export const receiptUrl = signature => `https://explorer.solana.com/tx/${signature}`

export function LastBuybackTime({ last, now }) {
  return <time dateTime={last.at} title={`${new Date(last.at).toUTCString()}`}>{formatAgo(last.at, now)}</time>
}

// What the fees-since figure is, in words that match how it was computed.
export function feesSinceLabel(since, hasLast) {
  const when = hasLast ? 'since the last platform-wallet buyback' : 'so far'
  return since.basis === 'policy' ? `Buyback share of fees ${when}` : `Platform fees collected ${when}`
}

const SOURCE_LABEL = { custody: 'buyback wallet', team: 'team wallet' }

// /stats: the latest buyback from any wallet; the policy figures (fees since the last platform-revenue buyback, standing
// against the 60% share) fold under Details, and a figure that cannot be read is left out.
export function BuybackStatus({ status, now = Date.now() }) {
  const last = status?.last ?? null, latest = status?.latest ?? last, since = status?.since ?? null, standing = status?.standing ?? null
  const ahead = standing ? BigInt(standing.aheadLamports) : 0n
  return <section className="analytics-revenue buyback-status" aria-labelledby="buyback-status-title">
    <div className="analytics-section-heading"><div><h2 id="buyback-status-title">Buyback status</h2><p>{BUYBACK_NOTE}</p></div></div>
    <div className="analytics-reserves buyback-status-grid">
      <div><span>Last buyback</span>{latest
        ? <><strong><LastBuybackTime last={latest} now={now}/></strong><small>{formatSolDisplay(latest.spentLamports)} SOL spent · {formatTokenCompact(latest.tokenBaseUnits)} ${OFFICIAL_TOKEN.symbol} bought{SOURCE_LABEL[latest.source] ? ` · ${SOURCE_LABEL[latest.source]}` : ''} · <a href={receiptUrl(latest.signature)} target="_blank" rel="noopener noreferrer">Receipt ↗</a></small></>
        : <><strong>None yet</strong><small>No buyback has been recorded.</small></>}</div>
    </div>
    <details className="analytics-data"><summary>Details</summary>
      <p>{MISSION_NOTE}</p>
      {(since || standing) && <div className="analytics-reserves buyback-status-grid">
        {since && <div><span>{feesSinceLabel(since, !!last)}</span><strong>{formatSolDisplay(since.lamports)} SOL</strong><small>{since.basis === 'policy'
          ? `${since.permille / 10}% of ${formatSolDisplay(since.totalLamports)} SOL in platform fees. Team buybacks are not subtracted.`
          : 'Total platform fees. No allocation policy is active, so no buyback share is applied.'}</small></div>}
        {standing && <div><span>Against the buyback policy</span>{ahead > 0n
          ? <><strong className="positive">{formatSolDisplay(standing.aheadLamports)} SOL ahead</strong><small>Team buybacks go beyond the 60% the policy requires.</small></>
          : <><strong>{formatSolDisplay(standing.owedLamports)} SOL due</strong><small>The 60% buyback share not yet spent. Published buybacks, including team-wallet buys since Sep 29, 2026, count toward it.</small></>}</div>}
      </div>}
      <p>Recorded amounts from collected platform fees, not a wallet balance or a promise to buy.</p>
    </details>
  </section>
}
