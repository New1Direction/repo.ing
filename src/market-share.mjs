import { publicGraduation } from './graduation-readiness.mjs'
import { formatUnits, formatSolRounded } from '../app/lib/format.mjs'

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

export function payoutShare(market, row, proof) {
  if (!row || row.status !== 'settled' || !row.settledAt || String(row.repoId) !== String(market.repoId) ||
      proof?.status !== 'settled' || proof.signature !== row.claimSignature || BigInt(proof.amountBaseUnits) !== BigInt(row.amountBaseUnits) ||
      BigInt(row.amountBaseUnits) <= 0n) throw Error('A verified builder payout is not available yet')
  const amount = formatUnits(row.amountBaseUnits), timestamp = new Date(row.settledAt).toISOString()
  const raw = BigInt(row.amountBaseUnits)
  const metric = raw < 100000n ? '<0.0001 SOL' : `${raw % 100000n ? '≈ ' : ''}${formatSolRounded(raw)} SOL`
  return { kind: 'payout', headline: 'Open source. Builders paid.', metric, detail: 'Builder fees paid to the verified payout wallet',
    note: 'Finalized on Solana · Trading fees, not donations', signature: row.claimSignature, timestamp,
    caption: `${market.fullName} earned and claimed ${amount} SOL in builder fees on repo.ing.\nSettled: ${timestamp}\nReceipt: https://explorer.solana.com/tx/${row.claimSignature}\n${marketUrl(market)}` }
}
const marketUrl = market => `https://repo.ing/token/${market.mint}`
