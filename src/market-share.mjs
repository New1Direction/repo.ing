import { publicGraduation } from './graduation-readiness.mjs'
import { isStockPairMarket, stockSymbol } from './stock-owner-claims.mjs'
import { formatUnits, formatSolRounded } from '../app/lib/format.mjs'

// The share cards a market offers (app/api/market/[mint]/share-card): its graduation progress only while it is on its bonding
// curve, and its latest verified builder payout. A stock pair offers neither: its progress is in its stock, and it has no owner
// claim, so no builder payout (src/stock-owner-claims.mjs). market: a row from server.mjs (graduated, migrated, the stamp).
export const SHARE_CARD_KINDS = Object.freeze(['graduation', 'payout'])
export function shareCardKinds(market) {
  if (isStockPairMarket(market)) return []
  return market?.graduated || market?.migrated ? ['payout'] : [...SHARE_CARD_KINDS]
}

// Final answers, which a retry cannot change (the card shows them without a Retry button); anything else is transient.
export const SHARE_CARD_ERRORS = Object.freeze({ CARD_NOT_OFFERED: 'CARD_NOT_OFFERED', NO_PAYOUT_YET: 'NO_PAYOUT_YET' })

// Why `kind` is not offered for this market, as the route answers it.
export function shareCardNotOffered(market, kind) {
  const error = isStockPairMarket(market)
    ? `Share cards cover SOL markets only: this market's progress is in ${stockSymbol(market)}, and a stock pair has no builder payout to show.`
    : kind === 'graduation' ? 'This market has graduated, so there is no bonding-curve progress to share. Its latest builder payout can be shared instead.'
      : 'This card is not available for this market.'
  return { error, code: SHARE_CARD_ERRORS.CARD_NOT_OFFERED, kinds: shareCardKinds(market) }
}

// A market without a settled payout yet. model: a Hugging Face model market, whose payouts go to the model's owner.
export function noPayoutYet(market, { model = false } = {}) {
  return { error: model ? 'No payout to the model owner yet. This card shows the latest verified payout once the model owner claims fees.'
    : 'No builder payout yet. This card shows the latest verified payout once a repository admin claims builder fees.',
  code: SHARE_CARD_ERRORS.NO_PAYOUT_YET, kinds: shareCardKinds(market) }
}

export function graduationShare(market, row, now = Date.now()) {
  const state = JSON.parse(row?.observation || '{}')
  if (state.mint !== market.mint || String(state.repoId) !== String(market.repoId) || state.curve !== market.pool) throw Error('Market evidence does not match')
  if (JSON.parse(row.reconciliation || '{}').status !== 'MATCH') throw Error('Progress is awaiting reconciliation')
  const progress = publicGraduation(row, now)
  if (progress.phase !== 'CURVE' || progress.status !== 'active') throw Error('This market is no longer on its bonding curve')
  const reserve = BigInt(progress.reserveLamports), target = BigInt(progress.thresholdLamports)
  if (target <= 0n || reserve < 0n || reserve > target || BigInt(progress.remainingLamports) !== target - reserve) throw Error('Progress evidence is inconsistent')
  const percent = Number(reserve * 10000n / target) / 100
  const detail = `≈ ${formatUnits(reserve, 9, 4)} / ${formatUnits(target)} SOL · ${percent.toFixed(2)}%`
  const timestamp = new Date(progress.chainTime).toISOString()
  return { kind: 'graduation', headline: 'On the road to graduation', metric: `${percent.toFixed(2)}%`, detail,
    note: `≈ ${formatUnits(target - reserve, 9, 4)} SOL remaining`, percent, timestamp,
    caption: `${market.fullName} on repo.ing\nGraduation progress: ${detail}\nSnapshot: ${timestamp}\n${marketUrl(market)}` }
}

// One verified payout, never a total: the card proves only this receipt. latest: it is the market's newest settled payout (the
// route's default read); false for a payout asked for by its signature. model: a Hugging Face model market, paid to its owner.
export function payoutShare(market, row, proof, { latest = true, model = false } = {}) {
  if (!row || row.status !== 'settled' || !row.settledAt || String(row.repoId) !== String(market.repoId) ||
      proof?.status !== 'settled' || proof.signature !== row.claimSignature || BigInt(proof.amountBaseUnits) !== BigInt(row.amountBaseUnits) ||
      BigInt(row.amountBaseUnits) <= 0n) throw Error('A verified builder payout is not available yet')
  const amount = formatUnits(row.amountBaseUnits), timestamp = new Date(row.settledAt).toISOString()
  const raw = BigInt(row.amountBaseUnits)
  const metric = raw < 100000n ? '<0.0001 SOL' : `${raw % 100000n ? '≈ ' : ''}${formatSolRounded(raw)} SOL`
  const payout = model ? 'payout to the model owner' : 'builder payout'
  const headline = latest ? `Latest ${payout}` : `${payout[0].toUpperCase()}${payout.slice(1)}`
  return { kind: 'payout', headline, metric,
    detail: model ? 'Fees paid to the model owner’s verified payout wallet' : 'Builder fees paid to the verified payout wallet',
    note: 'Finalized on Solana · Trading fees, not donations', signature: row.claimSignature, timestamp,
    caption: `${headline} for ${market.fullName} on repo.ing: ${amount} SOL.\nSettled: ${timestamp}\nReceipt: https://explorer.solana.com/tx/${row.claimSignature}\n${marketUrl(market)}` }
}
const marketUrl = market => `https://repo.ing/token/${market.mint}`
