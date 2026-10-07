export const DISCOVERY_VERSION = 2
export const DISCOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const DISCOVERY_CAP = 2_500_000_000n
export const DISCOVERY_CAPS = Object.freeze({ 1: 1_000_000_000n, 2: DISCOVERY_CAP })
export function discoveryCap(version) {
  const cap = DISCOVERY_CAPS[version]
  if (!cap) throw new Error('Unknown discovery policy version')
  return cap
}

// V1 rules are immutable for enrolled launches. Round once across eligible partner
// fees, so batching, replay, and out-of-order indexing cannot change rewards.
export function discoveryEarned(partnerAmount, version = 1) {
  const amount = BigInt(partnerAmount)
  if (amount < 0n) throw new Error('Negative partner fee evidence')
  const cap = discoveryCap(version)
  return amount / 2n > cap ? cap : amount / 2n
}

export function eligibleDiscoveryFee(market, data) {
  if (market.discoveryVersion === null || market.discoveryVersion === undefined) return false
  discoveryCap(market.discoveryVersion)
  const start = new Date(market.launchBlockTime).getTime()
  const time = Number(data.currentTimestamp.toString()) * 1000
  if (!market.launchBlockTime || !Number.isSafeInteger(start) || !Number.isSafeInteger(time)) {
    throw new Error('Discovery fee has no verified launch or trade timestamp')
  }
  return time >= start && time < start + DISCOVERY_WINDOW_MS
}

// earlyAccess: whether the caller takes contributor early access markets (EARLY_ACCESS_DBC_CONFIG; docs/EARLY_ACCESS.md, step 6e).
// Only then is such a market enrolled here; its stamp comes with it, for the config resolver.
export async function discoverySummary(pool, repoId, { earlyAccess = false } = {}) {
  const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.pool,
    m.early_access_end as "earlyAccessEnd", m.transfer_hook_program as "transferHookProgram",
    m.launcher_wallet as wallet, m.creator_wallet as "creatorWallet", m.launch_block_time as "launchedAt", m.discovery_version as version,
    coalesce((select sum(f.partner_amount) from discovery_fee_events f where f.github_repo_id = m.github_repo_id and f.discovery_eligible),0)::text as "partnerEarned",
    coalesce((select sum(c.amount) from discovery_claims c where c.github_repo_id = m.github_repo_id and c.status = 'settled'),0)::text as paid
    from markets m where m.github_repo_id = $1 and m.discovery_version in (1,2) and m.status = 'confirmed'
    and m.indexed_at is not null and m.launch_finality = 'finalized' and m.launch_block_time is not null
    and (m.early_access_end is null or $2::boolean) and m.bundle_id is null`, [String(repoId), earlyAccess])
  const market = rows[0]
  if (!market) return null
  const cap = discoveryCap(market.version)
  const earned = discoveryEarned(market.partnerEarned, market.version)
  const remaining = earned - BigInt(market.paid)
  if (remaining < 0n) throw new Error('Discovery payouts exceed verified rewards; settlement review required')
  const { rows: claims } = await pool.query(`select id, status, signature, amount::text, resolution_reason as reason from discovery_claims
    where github_repo_id = $1 order by created_at desc limit 1`, [String(repoId)])
  const expiresAt = new Date(market.launchedAt.getTime() + DISCOVERY_WINDOW_MS)
  return { ...market, earned: earned.toString(), remaining: remaining.toString(), expiresAt,
    cap: cap.toString(), capped: earned === cap, expired: Date.now() >= expiresAt.getTime(), latestClaim: claims[0] ?? null }
}
