import { formatSolDisplay } from '../lib/format.mjs'
import { formatAgo, formatTokenCompact } from '../lib/buyback-summary.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'

export const BUYBACK_NOTE = 'Buybacks are executed manually by the team; every one is published here with its on-chain receipt.'
export const MISSION_NOTE = 'We are dedicated to building the market layer for open source. Platform fees fund $REPOING buybacks, protocol liquidity and the treasury under the published 60/20/20 policy, and the team adds its own buybacks on top. Every buyback, token lock and liquidity deposit is published with its on-chain receipt so anyone can verify it.'
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

// /stats: the latest buyback from any wallet, fees since the last platform-revenue buyback, and how buybacks happen.
export function BuybackStatus({ status, now = Date.now() }) {
  const last = status?.last ?? null, latest = status?.latest ?? last, since = status?.since ?? null, standing = status?.standing ?? null
  const ahead = standing ? BigInt(standing.aheadLamports) : 0n
  return <section className="analytics-revenue buyback-status" aria-labelledby="buyback-status-title">
    <div className="analytics-section-heading"><div><h2 id="buyback-status-title">Buyback status</h2><p>{BUYBACK_NOTE}</p></div></div>
    <p className="analytics-note buyback-mission">{MISSION_NOTE}</p>
    <div className="analytics-reserves buyback-status-grid">
      <div><span>Last buyback</span>{latest
        ? <><strong><LastBuybackTime last={latest} now={now}/></strong><small>{formatSolDisplay(latest.spentLamports)} SOL spent · {formatTokenCompact(latest.tokenBaseUnits)} ${OFFICIAL_TOKEN.symbol} bought{SOURCE_LABEL[latest.source] ? ` · ${SOURCE_LABEL[latest.source]}` : ''} · <a href={receiptUrl(latest.signature)} target="_blank" rel="noopener noreferrer">Receipt ↗</a></small></>
        : <><strong>None yet</strong><small>No buyback has been recorded.</small></>}</div>
      <div><span>{since ? feesSinceLabel(since, !!last) : 'Platform fees since the last buyback'}</span>{since
        ? <><strong>{formatSolDisplay(since.lamports)} SOL</strong><small>{since.basis === 'policy'
          ? `${since.permille / 10}% of ${formatSolDisplay(since.totalLamports)} SOL in claimed platform fees. Team-wallet buybacks aren't subtracted here; see the policy standing for the net figure.`
          : 'Total claimed platform fees. No allocation policy is active, so no buyback share is applied.'}</small></>
        : <><strong>—</strong><small>Unavailable while platform accounting is being verified.</small></>}</div>
      <div><span>Against the buyback policy</span>{standing
        ? ahead > 0n
          ? <><strong className="positive">{formatSolDisplay(standing.aheadLamports)} SOL ahead</strong><small>Team-wallet buybacks go beyond the 60% commitment, so buybacks are ahead of what the policy requires.</small></>
          : <><strong>{formatSolDisplay(standing.owedLamports)} SOL due</strong><small>The 60% buyback share not yet spent. Published buybacks, including team-wallet buys since Sep 29, 2026, count toward it.</small></>
        : <><strong>—</strong><small>Unavailable while platform accounting is being verified.</small></>}</div>
    </div>
    <p className="analytics-note">Ledger amounts from settled platform-fee claims, not a wallet balance or a commitment to buy.</p>
  </section>
}
