import { normalizeTrades } from './trade-integrity.mjs'

// Sustained market health for post-launch builder rewards (docs/LAUNCH_TRANSPARENCY.md#post-launch-builder-rewards): liquidity that
// stays executable over weeks, holdings spread across many independent controllers, and early buyers who are still holding.
// First-hour volume, total volume, price and market cap are deliberately absent: none of them can make a market eligible.
// Holdings come from finalized swaps of linked clusters (src/wallet-clusters.mjs), so splitting one position across wallets
// that trade in one transaction does not add holders; tokens moved by plain transfer are not seen (reported as a limit).
// The assessment is a PREVIEW: no reward is funded or paid by this code.

const DAY = 86_400_000
export const HEALTH_VERSION = 1
// 10,000 tokens (0.001% of the fixed one-billion supply): smaller positions are dust and never count as a holder.
export const DUST_BASE_UNITS = 10_000_000_000n
export const EARLY_COHORT_DAYS = 7
export const RETENTION_DAYS = 30
export const LIQUIDITY_WINDOW_DAYS = 30
export const SAMPLE_INTERVAL_MS = 3_600_000
// A sample counts toward uptime when both sides hold at least this much SOL within the 2% band and the quoted spread at
// 0.1 SOL is at most UPTIME_MAX_SPREAD_BPS.
export const UPTIME_MIN_DEPTH_LAMPORTS = 100_000_000n
export const UPTIME_MAX_SPREAD_BPS = 1_000

export const BUILDER_REWARD_RULES = Object.freeze({
  minAgeDays: 30,
  minMedianDepthLamports: 500_000_000n,
  minUptimePercent: 90,
  minSampleCoveragePercent: 50,
  minEffectiveHolders: 20,
  minEarlyRetentionPercent: 30,
  minOrganicPercent: 70,
})

const median = values => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor((sorted.length - 1) / 2)]
}
const pct = (part, whole) => whole > 0 ? Math.round(part * 10_000 / whole) / 100 : null

// Net token position per controller after the given events (labeled wallets excluded).
function positionsAt(events, { labels, clusterOf, until = Infinity }) {
  const net = new Map(), firstBuy = new Map()
  for (const event of events) {
    if (event.at > until) break
    if (!event.trader || labels.has(event.trader)) continue
    const id = clusterOf.get(event.trader) ?? event.trader
    net.set(id, (net.get(id) ?? 0n) + (event.direction === 'buy' ? event.tokens : -event.tokens))
    if (event.direction === 'buy' && !firstBuy.has(id)) firstBuy.set(id, event.at)
  }
  return { net, firstBuy }
}
const holding = (net, id) => (net.get(id) ?? 0n) >= DUST_BASE_UNITS

export function holderDiversity(rows, { labels = new Map(), clusterOf = new Map(), now = Date.now() } = {}) {
  const { events } = normalizeTrades(rows)
  const { net } = positionsAt(events, { labels, clusterOf, until: now })
  const held = [...net.values()].filter(amount => amount >= DUST_BASE_UNITS)
  const total = held.reduce((sum, amount) => sum + amount, 0n)
  const squares = held.reduce((sum, amount) => sum + amount * amount, 0n)
  const top = [...held].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 10).reduce((sum, amount) => sum + amount, 0n)
  return {
    holders: held.length,
    // Inverse Herfindahl index: the number of equal holders that would give the same concentration.
    effectiveHolders: squares > 0n ? Number(total * total * 100n / squares) / 100 : 0,
    top10PercentOfHolders: total > 0n ? Number(top * 10_000n / total) / 100 : null,
  }
}

export function holderRetention(rows, { labels = new Map(), clusterOf = new Map(), launchAt, now = Date.now() } = {}) {
  const { events } = normalizeTrades(rows)
  const launch = launchAt instanceof Date ? launchAt.getTime() : Number(launchAt)
  const ageDays = Number.isFinite(launch) ? (now - launch) / DAY : null
  const current = positionsAt(events, { labels, clusterOf, until: now })
  // Early cohort: controllers whose first buy landed in the first EARLY_COHORT_DAYS.
  const cohort = Number.isFinite(launch) ? [...current.firstBuy].filter(([, at]) => at - launch <= EARLY_COHORT_DAYS * DAY).map(([id]) => id) : []
  const retained = cohort.filter(id => holding(current.net, id))
  // Holders RETENTION_DAYS ago who still hold.
  const past = positionsAt(events, { labels, clusterOf, until: now - RETENTION_DAYS * DAY })
  const pastHolders = [...past.net.keys()].filter(id => holding(past.net, id))
  const stayed = pastHolders.filter(id => holding(current.net, id))
  const mature = ageDays !== null && ageDays >= RETENTION_DAYS
  return {
    ageDays: ageDays === null ? null : Math.floor(ageDays * 10) / 10,
    earlyCohort: cohort.length, earlyRetained: retained.length,
    earlyRetentionPercent: mature ? pct(retained.length, cohort.length) : null,
    holdersThirtyDaysAgo: pastHolders.length, stillHolding: stayed.length,
    holderRetentionPercent: mature ? pct(stayed.length, pastHolders.length) : null,
    mature,
  }
}

// samples: market_liquidity_samples rows of the last LIQUIDITY_WINDOW_DAYS (newest first or any order).
export function sustainedLiquidity(samples, { launchAt = null, now = Date.now() } = {}) {
  const since = now - LIQUIDITY_WINDOW_DAYS * DAY
  const launch = launchAt instanceof Date ? launchAt.getTime() : launchAt === null ? null : Number(launchAt)
  const rows = (samples ?? []).map(row => ({ at: new Date(row.sampledAt).getTime(), buy: BigInt(row.buyDepthLamports ?? 0),
    sell: BigInt(row.sellDepthLamports ?? 0), spread: row.spreadBps === null || row.spreadBps === undefined ? null : Number(row.spreadBps),
    twoSided: Boolean(row.twoSided), reserve: row.quoteReserveLamports === null || row.quoteReserveLamports === undefined ? null : BigInt(row.quoteReserveLamports) }))
    .filter(row => Number.isFinite(row.at) && row.at >= since && row.at <= now)
  const start = Math.max(since, Number.isFinite(launch) ? launch : since)
  const expected = Math.max(1, Math.floor((now - start) / SAMPLE_INTERVAL_MS))
  const minDepth = rows.map(row => (row.buy < row.sell ? row.buy : row.sell))
  const up = rows.filter(row => row.twoSided && row.buy >= UPTIME_MIN_DEPTH_LAMPORTS && row.sell >= UPTIME_MIN_DEPTH_LAMPORTS &&
    row.spread !== null && row.spread <= UPTIME_MAX_SPREAD_BPS)
  const spreads = rows.map(row => row.spread).filter(value => value !== null)
  const reserves = rows.map(row => row.reserve).filter(value => value !== null)
  return {
    windowDays: LIQUIDITY_WINDOW_DAYS,
    samples: rows.length, expectedSamples: expected,
    coveragePercent: Math.min(100, pct(rows.length, expected) ?? 0),
    medianDepthLamports: median(minDepth)?.toString() ?? null,
    medianSpreadBps: median(spreads),
    medianQuoteReserveLamports: median(reserves)?.toString() ?? null,
    uptimePercent: rows.length ? pct(up.length, rows.length) : null,
  }
}

// The preview assessment: each rule pass / fail / unknown; eligible only when every rule passes.
export function builderRewardAssessment({ liquidity, diversity, retention, organicPercent }, rules = BUILDER_REWARD_RULES) {
  const rule = (id, label, value, ok, unknown = value === null || value === undefined) => ({ id, label, value: unknown ? null : value,
    status: unknown ? 'unknown' : ok ? 'pass' : 'fail' })
  const depth = liquidity?.medianDepthLamports === null || liquidity?.medianDepthLamports === undefined ? null : BigInt(liquidity.medianDepthLamports)
  const criteria = [
    rule('age', `Market at least ${rules.minAgeDays} days old`, retention?.ageDays ?? null, (retention?.ageDays ?? 0) >= rules.minAgeDays),
    rule('sample_coverage', `Liquidity sampled for at least ${rules.minSampleCoveragePercent}% of the window`, liquidity?.coveragePercent ?? null,
      (liquidity?.coveragePercent ?? 0) >= rules.minSampleCoveragePercent),
    rule('sustained_depth', `Median depth within 2% at least ${Number(rules.minMedianDepthLamports) / 1e9} SOL on each side`,
      depth === null ? null : depth.toString(), depth !== null && depth >= rules.minMedianDepthLamports),
    rule('uptime', `Two-sided liquidity at least ${rules.minUptimePercent}% of samples`, liquidity?.uptimePercent ?? null,
      (liquidity?.uptimePercent ?? 0) >= rules.minUptimePercent),
    rule('holder_diversity', `At least ${rules.minEffectiveHolders} effective holders`, diversity?.effectiveHolders ?? null,
      (diversity?.effectiveHolders ?? 0) >= rules.minEffectiveHolders),
    rule('early_retention', `At least ${rules.minEarlyRetentionPercent}% of first-week buyers still holding after ${RETENTION_DAYS} days`,
      retention?.earlyRetentionPercent ?? null, (retention?.earlyRetentionPercent ?? 0) >= rules.minEarlyRetentionPercent),
    rule('organic_volume', `At least ${rules.minOrganicPercent}% of attributed volume organic`, organicPercent ?? null,
      (organicPercent ?? 0) >= rules.minOrganicPercent),
  ]
  return {
    version: HEALTH_VERSION,
    status: 'preview',
    paid: false,
    eligible: criteria.every(item => item.status === 'pass'),
    criteria,
    excluded: ['first-hour volume', 'total volume', 'price', 'market cap', 'fees paid'],
  }
}
