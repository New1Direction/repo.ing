import { cache } from 'react'
import { database } from './server.mjs'
import { marketLaunchFeeTerms } from './launch-fee.mjs'
import { transparencyLabels } from './transparency-labels.mjs'
import { latestLiquiditySample, readStoredReport } from '../../src/market-transparency.mjs'
import { readSeedFacts, seededLiquidity } from '../../src/seeded-liquidity.mjs'
import { launcherPosition, readLauncherTrades } from '../../src/trust-signals.mjs'
import { launchedSchedule } from '../../src/launch-schedules.mjs'
import { launchStages, NOT_LIVE } from '../../src/launch-mechanism.mjs'
import { hasFairRamp, marketHookRules } from '../../src/early-access-rules.mjs'
import { RISK_DISCLOSURES } from '../../src/launch-quality.mjs'
import { LIQUIDITY_RECEIPTS, REPOING_POOL } from './liquidity-receipts.mjs'

// One market's transparency view (token page panel and /api/v1/markets/[mint]/transparency): the worker's stored report (Launch
// Quality, integrity, health, LP incentive preview), the latest liquidity sample, seeded liquidity with labels and lock states, and
// the staged launch mechanism. Database reads only; no RPC. null when the database is off; parts that fail are null.
const SUPPLY = 1_000_000_000_000_000n
const percent = tokens => Number(BigInt(tokens) * 1_000_000n / SUPPLY) / 10_000

export const marketTransparency = cache(async market => {
  const db = database()
  if (!db || !market?.mint) return null
  try {
    const { rows: [extra] } = await db.query(`select m.launch_signature as "launchSignature", m.builder_allocation_version as "builderAllocationVersion",
        m.bundle_id::text as "bundleId", coalesce(m.launch_block_time, m.indexed_at) as "launchedAt", m.early_access_end as "earlyAccessEnd",
        m.hook_rules as "hookRules", g.signature as "graduationSignature", g.pool as "graduatedPool", b.target_lamports::text as "groupRaiseLamports"
      from markets m left join graduation_events g on g.github_repo_id = m.github_repo_id left join bundles b on b.bundle_id = m.bundle_id
      where m.mint = $1`, [market.mint])
    if (!extra) return null
    const full = { ...market, ...extra, githubRepoId: market.repoId }
    const labels = transparencyLabels(full)
    const [report, sample, seedFacts, launcherRow, schedule, launchFee] = await Promise.all([
      readStoredReport(db, market.repoId).catch(() => null), latestLiquiditySample(db, market.repoId).catch(() => null),
      readSeedFacts(db, full).catch(() => null), readLauncherTrades(db, market.mint).catch(() => null),
      launchedSchedule(db, market.repoId).catch(() => null), marketLaunchFeeTerms(market).catch(() => null),
    ])
    const position = launcherRow ? launcherPosition(launcherRow) : null
    const seeded = seedFacts ? seededLiquidity({ market: full, ...seedFacts, launcherPosition: position, labels,
      manualLiquidity: extra.graduatedPool === REPOING_POOL ? LIQUIDITY_RECEIPTS : [] }) : null
    const launchBuys = (seedFacts?.launchTrades ?? []).filter(trade => trade.direction === 'buy')
    const spent = launchBuys.reduce((sum, trade) => sum + BigInt(trade.lamports), 0n), tokens = launchBuys.reduce((sum, trade) => sum + BigInt(trade.tokens), 0n)
    const rules = marketHookRules(full)
    const mechanism = launchStages({
      schedule,
      launch: { signature: extra.launchSignature, launchedAt: extra.launchedAt, initialBuyLamports: spent.toString(), initialBuyPercent: percent(tokens),
        groupLaunch: extra.bundleId !== null, groupRaiseLamports: extra.groupRaiseLamports },
      launchFee, earlyAccess: extra.earlyAccessEnd ? { end: extra.earlyAccessEnd, fairRamp: rules !== null && hasFairRamp(rules) } : null,
      curve: { thresholdLamports: sample?.profile?.thresholdLamports ?? null, bondingPercent: market.bondingPercent },
      graduated: extra.graduationSignature ? { signature: extra.graduationSignature } : null,
    })
    return { report, liquidity: sample, seeded, mechanism: { ...mechanism, notLive: NOT_LIVE }, schedule, disclosures: RISK_DISCLOSURES }
  } catch (error) {
    console.error('market transparency unavailable', { mint: market.mint, error: error.message })
    return null
  }
})

// The public JSON form (bigint-free; the stored report is already JSON).
export function transparencyJson(market, view) {
  return { market: { repoId: market.repoId, mint: market.mint, pool: market.pool, symbol: market.symbol, fullName: market.fullName ?? null },
    ...view, generatedAt: new Date().toISOString() }
}
