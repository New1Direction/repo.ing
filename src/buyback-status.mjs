import { activePolicy, platformRevenueSummary, reconcilePlatformRevenue } from './platform-revenue.mjs'
import { reconcileLiquidity } from './liquidity-deployment.mjs'

const PERMILLE = 1000n
const AMOUNT = /^\d+$/

// Chain order when both sides carry a slot, otherwise time. A tie is not "after", so a
// same-instant entry is never counted on both sides of a buyback.
export function isAfter(entry, mark) {
  if (!mark) return true
  if (entry.slot != null && mark.slot != null) return BigInt(entry.slot) > BigInt(mark.slot)
  return Date.parse(entry.at) > Date.parse(mark.at)
}

// Most recent platform-revenue buyback. Team-wallet buys are not paid from platform fees,
// so they never reset the fees-since figure.
export function lastBuyback(receipts, source = 'custody') {
  let last = null
  for (const receipt of Array.isArray(receipts) ? receipts : []) if (receipt.source === source && isAfter(receipt, last)) last = receipt
  return last
}

const validPermille = policy => Number.isInteger(policy?.buybackPermille) && policy.buybackPermille >= 0 && policy.buybackPermille <= 1000

// Settled platform-fee claims after the last buyback. With an active policy, each claim contributes
// its recorded buyback allocation, or the policy share (floored, as allocate() does) if not yet
// allocated. Without a policy only the total is reported and labelled as such.
export function feesSinceBuyback(claims, last, policy) {
  const permille = validPermille(policy) ? BigInt(policy.buybackPermille) : null
  let total = 0n, allocated = 0n, count = 0
  for (const claim of claims) {
    if (!AMOUNT.test(String(claim.amount)) || Number.isNaN(Date.parse(claim.at))) throw Error('Invalid platform fee claim')
    if (!isAfter(claim, last)) continue
    const amount = BigInt(claim.amount)
    total += amount; count++
    if (permille === null) continue
    allocated += claim.buybackAmount != null && AMOUNT.test(String(claim.buybackAmount)) ? BigInt(claim.buybackAmount) : amount * permille / PERMILLE
  }
  return permille === null
    ? { basis: 'total', lamports: total.toString(), totalLamports: total.toString(), claims: count }
    : { basis: 'policy', permille: Number(permille), lamports: allocated.toString(), totalLamports: total.toString(), claims: count }
}

let warned = false
// Last buyback from the shared receipts, plus fees since it from the same ledger /stats verifies.
// Never rejects: the fees figure is null whenever the ledger is unavailable or not reconciled.
export async function readBuybackStatus(db, receipts) {
  const last = lastBuyback(receipts)
  if (!db) return { last, since: null, standing: null }
  try {
    const [revenue, liquidity] = [await reconcilePlatformRevenue(db), await reconcileLiquidity(db)]
    if (revenue.status !== 'MATCH' || liquidity.status !== 'MATCH') return { last, since: null, standing: null }
    const policy = await activePolicy(db)
    const { rows } = await db.query(`select c.amount::text as amount, c.settled_at as "settledAt", a.buyback_amount::text as "buybackAmount"
      from platform_fee_claims c left join platform_revenue_allocations a on a.claim_signature = c.signature
      where c.status = 'settled' and ($1::timestamptz is null or c.settled_at > $1) order by c.settled_at limit 5000`, [last?.at ?? null])
    const claims = rows.map(({ settledAt, ...row }) => ({ ...row, at: new Date(settledAt).toISOString() }))
    // Where buybacks stand against the published policy (team-wallet buys since the cutoff count too).
    const summary = await platformRevenueSummary(db)
    const standing = { owedLamports: summary.buybackReserve, aheadLamports: summary.buybackAhead ?? '0' }
    return { last, since: feesSinceBuyback(claims, last, policy), standing }
  } catch (error) {
    if (!warned) { warned = true; console.error('buyback status fees unavailable', error?.code ?? error?.message ?? 'error') }
    return { last, since: null, standing: null }
  }
}
