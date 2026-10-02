import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import { parseReferrer, REFERRAL_FEE_PERCENT_OF_TRADING_FEE } from './referral.mjs'

// Public referral leaderboard (migration 0043): one trade_referrers row per verified site trade whose swap paid a
// referral. Earnings are estimates, 4% of the trading fee quoted at prepare; the real payout lands in the referrer's own
// WSOL account. Recording is best effort and never changes what the trader sees.
export const LEADERBOARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const LEADERBOARD_LIMIT = 10
const U64 = /^(0|[1-9]\d{0,19})$/
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/
const REPO_ID = /^[1-9]\d{0,18}$/

// The row for a verified trade's prepared record, or null when the swap paid no referral or the record cannot vouch for
// one: the referral account pinned in the signed swap must be the recorded referrer's own WSOL account.
export function referredTradeRow(record, signature) {
  if (!record?.referral || typeof record.referrer !== 'string' || typeof signature !== 'string' || !SIGNATURE.test(signature)) return null
  const referrer = parseReferrer(record.referrer)
  if (!referrer || getAssociatedTokenAddressSync(NATIVE_MINT, referrer).toBase58() !== record.referral) return null
  const fee = record.tradingFeeLamports, repoId = record.githubRepoId
  if (typeof fee !== 'string' || !U64.test(fee) || typeof repoId !== 'string' || !REPO_ID.test(repoId) ||
      !['curve', 'graduated'].includes(record.phase) || !['buy', 'sell'].includes(record.direction)) return null
  return { signature, referrer: referrer.toBase58(), githubRepoId: repoId, phase: record.phase, direction: record.direction, tradingFeeLamports: fee }
}

// The first verification of a signature wins; status polls and replicas repeat it harmlessly.
export async function recordReferredTrade(db, prepared, signature, { log = console.error } = {}) {
  const row = referredTradeRow(prepared?.record, signature)
  if (!db || !row) return false
  try {
    const { rowCount } = await db.query(`insert into trade_referrers(signature, referrer, github_repo_id, phase, direction, trading_fee_lamports)
      values($1,$2,$3,$4,$5,$6) on conflict(signature) do nothing`,
    [row.signature, row.referrer, row.githubRepoId, row.phase, row.direction, row.tradingFeeLamports])
    return rowCount === 1
  } catch (error) {
    log('referred trade not recorded', error?.code ?? error?.name ?? 'error')
    return false
  }
}

export const estimatedReferralLamports = tradingFeeLamports =>
  BigInt(tradingFeeLamports) * BigInt(REFERRAL_FEE_PERCENT_OF_TRADING_FEE) / 100n

// Shown publicly, so never the whole address.
export const truncateWallet = wallet => typeof wallet === 'string' && wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : '—'

// One ranked entry. Integer division per trade, like the floor the program applies to each referral fee.
const entry = row => ({ wallet: truncateWallet(row.referrer), trades: Number(row.trades), estimatedLamports: String(row.estimated) })

// Top referrers by estimated earnings for the last 7 days and for all time.
export async function readReferralLeaderboard(db, { now = Date.now(), limit = LEADERBOARD_LIMIT } = {}) {
  const read = since => db.query(`select referrer, count(*)::int as trades, sum(div(trading_fee_lamports * $2, 100))::text as estimated
    from trade_referrers where $1::timestamptz is null or settled_at >= $1
    group by referrer order by sum(div(trading_fee_lamports * $2, 100)) desc, count(*) desc, referrer limit $3`,
  [since, REFERRAL_FEE_PERCENT_OF_TRADING_FEE, limit])
  const [week, allTime] = await Promise.all([read(new Date(now - LEADERBOARD_WINDOW_MS)), read(null)])
  return { week: week.rows.map(entry), allTime: allTime.rows.map(entry) }
}
