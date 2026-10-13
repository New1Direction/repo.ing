import { launchQualityReport } from './launch-quality.mjs'
import { integrityView, readMarketTrades, tradeIntegrity } from './trade-integrity.mjs'
import { clusterWallets, platformLinks, readWalletLinks, sameTransactionLinks } from './wallet-clusters.mjs'
import { builderRewardAssessment, holderDiversity, holderRetention, sustainedLiquidity } from './market-health.mjs'
import { INCENTIVE_WINDOW_DAYS, lpIncentives } from './liquidity-incentives.mjs'
import { curveSnapshot, dammSnapshot, sampleSummary, snapshotProfile } from './market-liquidity.mjs'
import { readLpPositions } from './lp-positions.mjs'
import { launcherPosition, readLauncherTrades, sharePercent } from './trust-signals.mjs'
import { launchedSchedule, reconcileSchedules } from './launch-schedules.mjs'
import { produceFeedEvents } from './launch-feed.mjs'
import { deliverDue, fanOutDeliveries } from './launch-webhooks.mjs'

// The worker's transparency job (docs/LAUNCH_TRANSPARENCY.md): keeps the public launch feed and scheduled launches current, samples
// every market's executable liquidity and every graduated pool's LP positions about hourly, and stores one transparency report
// per market (Launch Quality, trading integrity, sustained health, LP incentive preview). Read-only toward Solana: it never
// signs or sends anything. Each part is bounded per run, so a large backlog spreads over several runs instead of one burst of
// RPC reads. Every database step tolerates a database the 0071 migration has not reached (it reports NOT_MIGRATED).
export const TRANSPARENCY_LIMITS = Object.freeze({
  liquidityPerRun: 20, lpPoolsPerRun: 5, reportsPerRun: 10,
  sampleEveryMs: 60 * 60_000, reportEveryMs: 60 * 60_000, retentionDays: 120,
})
const DAY = 86_400_000

const MARKETS = `select m.id, m.github_repo_id::text as "githubRepoId", m.mint, m.pool, m.launcher_wallet as "launcherWallet", m.creator_wallet as "creatorWallet",
  m.launch_signature as "launchSignature", coalesce(m.launch_block_time, m.indexed_at) as "launchedAt", m.indexed_at as "indexedAt",
  m.bundle_id::text as "bundleId", m.builder_allocation_version as "builderAllocationVersion", m.transfer_hook_program as "transferHookProgram",
  g.pool as "graduatedPool", g.signature as "graduationSignature", g.recorded_at as "graduatedAt",
  b.wallet as "beneficiaryWallet", b.method as "beneficiaryMethod"
  from markets m left join graduation_events g on g.github_repo_id = m.github_repo_id
  left join repo_beneficiaries b on b.github_repo_id = m.github_repo_id
  where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' and m.quote_asset_id is null`

const missingTable = error => error?.code === '42P01'

export async function dueMarkets(db, { kind, limit, now = Date.now(), everyMs }) {
  const cutoff = new Date(now - everyMs)
  const sql = kind === 'liquidity'
    ? `${MARKETS} and not exists (select 1 from market_liquidity_samples s where s.github_repo_id = m.github_repo_id and s.sampled_at > $1)
       order by (select max(sampled_at) from market_liquidity_samples s where s.github_repo_id = m.github_repo_id) nulls first, m.id limit $2`
    : kind === 'lp'
      ? `${MARKETS} and g.pool is not null and not exists (select 1 from lp_position_samples s where s.github_repo_id = m.github_repo_id and s.sampled_at > $1)
       order by m.id limit $2`
      : `${MARKETS} and not exists (select 1 from launch_quality_reports q where q.github_repo_id = m.github_repo_id and q.assessed_at > $1
         and q.assessed_at > m.indexed_at) order by (select assessed_at from launch_quality_reports q where q.github_repo_id = m.github_repo_id) nulls first, m.id limit $2`
  const { rows } = await db.query(sql, [cutoff, limit])
  return rows
}

// One liquidity sample: venue snapshot → profile → row.
export async function sampleMarketLiquidity(db, market, { connection, resolveConfig, now = Date.now() }) {
  const snapshot = market.graduatedPool
    ? await dammSnapshot({ connection, market, pool: market.graduatedPool })
    : await curveSnapshot({ connection, market, configKey: resolveConfig(market) })
  const profile = snapshotProfile(snapshot)
  const summary = sampleSummary(profile)
  await db.query(`insert into market_liquidity_samples (github_repo_id, sampled_at, venue, pool, sqrt_price, fee_bps, quote_reserve_lamports,
      buy_depth_lamports, sell_depth_lamports, spread_bps, two_sided, profile) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
  [market.githubRepoId, new Date(now), profile.venue, profile.pool, profile.sqrtPrice, Math.min(10_000, Math.max(0, summary.feeBps)),
    profile.quoteReserveLamports, summary.buyDepthLamports, summary.sellDepthLamports, summary.spreadBps, summary.twoSided, profile])
  return { profile, summary }
}

export async function sampleLpPositions(db, market, { connection, now = Date.now(), read = readLpPositions }) {
  const result = await read({ connection, pool: market.graduatedPool })
  const at = new Date(now)
  for (const row of result.positions) {
    await db.query(`insert into lp_position_samples (github_repo_id, sampled_at, pool, position, owner, liquidity, permanent_locked_liquidity, pool_liquidity)
      values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (position, sampled_at) do nothing`, [market.githubRepoId, at, result.pool, row.position, row.owner,
      row.liquidity.toString(), row.permanentLockedLiquidity.toString(), result.poolLiquidity.toString()])
  }
  return { positions: result.positions.length, truncated: result.truncated }
}

export async function latestLiquiditySample(db, repoId) {
  try {
    const { rows } = await db.query(`select sampled_at as "sampledAt", venue, pool, sqrt_price::text as "sqrtPrice", fee_bps as "feeBps",
        quote_reserve_lamports::text as "quoteReserveLamports", buy_depth_lamports::text as "buyDepthLamports", sell_depth_lamports::text as "sellDepthLamports",
        spread_bps as "spreadBps", two_sided as "twoSided", profile
      from market_liquidity_samples where github_repo_id = $1 order by sampled_at desc limit 1`, [String(repoId)])
    return rows[0] ?? null
  } catch (error) { if (missingTable(error)) return null; throw error }
}

async function readSamples(db, repoId, sinceMs) {
  const { rows } = await db.query(`select sampled_at as "sampledAt", buy_depth_lamports::text as "buyDepthLamports", sell_depth_lamports::text as "sellDepthLamports",
      spread_bps as "spreadBps", two_sided as "twoSided", quote_reserve_lamports::text as "quoteReserveLamports"
    from market_liquidity_samples where github_repo_id = $1 and sampled_at >= $2 order by sampled_at`, [String(repoId), new Date(sinceMs)])
  return rows
}

async function readRepositoryFacts(db, repoId) {
  const { rows: [repo] } = await db.query(`select r.full_name as "fullName", r.stars, r.forks, r.github_created_at as "githubCreatedAt",
      r.synced_at as "syncedAt", r.fork_parent_full_name as "forkParent", r.lineage_checked_at as "lineageCheckedAt",
      (select min(verified_at) from repo_verifications v where v.github_repo_id = r.github_repo_id and v.permission = 'admin') as "verifiedAt"
    from repositories r where r.github_repo_id = $1`, [repoId])
  let declined = null
  try {
    ;({ rows: [declined] } = await db.query(`select created_at as "decidedAt" from maintainer_opt_outs where github_repo_id = $1 and withdrawn_at is null and kind = 'decline' limit 1`, [repoId]))
  } catch (error) { if (!missingTable(error)) throw error }
  return { repo, declined: declined ?? null }
}

// Everything one market's report needs, read once. Injected readers keep the job testable without RPC or GitHub.
export async function buildMarketReport(db, market, { labels: given = new Map(), holderSnapshot = async () => null, pulseFor = async () => null,
  launchFeeFor = async () => null, feeClaimerFor = async () => null, configFor = () => null, now = Date.now() }) {
  const repoId = market.githubRepoId
  // repo.ing's wallets from on-chain facts, not only from signer keys this process may not hold: the pool creator stamped on the
  // market, and the config's fee claimer (the partner).
  const labels = new Map(given)
  if (market.creatorWallet && !labels.has(market.creatorWallet)) labels.set(market.creatorWallet, { kind: 'platform', label: 'repo.ing pool creator' })
  const feeClaimer = await feeClaimerFor(market).catch(() => null)
  if (feeClaimer && !labels.has(feeClaimer)) labels.set(feeClaimer, { kind: 'platform', label: 'repo.ing partner (fee claimer)' })
  const [{ repo, declined }, launcherRow, trades, samples, scheduled, pulse, holders, launchFee] = await Promise.all([
    readRepositoryFacts(db, repoId), readLauncherTrades(db, market.mint), readMarketTrades(db, { pool: market.pool, repoId }),
    readSamples(db, repoId, now - 30 * DAY), launchedSchedule(db, repoId), pulseFor(repoId).catch(() => null),
    holderSnapshot(market).catch(() => null), launchFeeFor(market).catch(() => null),
  ])
  const traders = [...new Set(trades.map(row => row.trader).filter(Boolean))]
  const links = [...sameTransactionLinks(trades), ...platformLinks(labels), ...await readWalletLinks(db, traders)]
  const { clusterOf } = clusterWallets(traders, links)
  const integrity = tradeIntegrity(trades, { labels, clusterOf })
  const position = launcherRow ? launcherPosition(launcherRow) : null
  // Tokens bought in the launch transaction: the launcher's own buy, or a Group launch vault's.
  const launchTokens = trades.filter(row => row.signature === market.launchSignature && row.direction === 'buy').reduce((sum, row) => sum + BigInt(row.tokens), 0n)
  // A sample older than a day says little about the market now: the criterion is then unknown.
  const latest = await latestLiquiditySample(db, repoId)
  const fresh = latest && now - new Date(latest.sampledAt).getTime() <= DAY ? latest : null
  const proof = market.graduatedPool ? (await db.query(`select signature, recorded_at as "recordedAt", creator_position as "creatorPosition",
    partner_position as "partnerPosition" from graduated_migration_proofs where github_repo_id = $1`, [repoId])).rows[0] ?? null : null
  const quality = launchQualityReport({
    repo: repo ?? null,
    pulse: pulse && pulse.status !== 'pending' ? pulse : null,
    forkParent: repo?.lineageCheckedAt ? repo.forkParent ?? null : undefined,
    maintainer: repo ? { verified: Boolean(repo.verifiedAt), verifiedAt: repo.verifiedAt, declined: Boolean(declined), decidedAt: declined?.decidedAt ?? null } : null,
    launch: { signature: market.launchSignature, launchedAt: market.launchedAt, mint: market.mint, bundle: market.bundleId !== null,
      launchBuyPercent: market.launchSignature ? sharePercent(launchTokens, 1_000_000_000_000_000n) : null,
      launchFee, config: configFor(market), scheduled },
    holders: holders ? { ...holders, observedAt: holders.observedAt ?? new Date(now).toISOString() } : null,
    launcher: position ? { ...position, wallet: market.launcherWallet } : null,
    integrity: { ...integrity, observedAt: new Date(now).toISOString() },
    liquidity: fresh,
    lpLock: market.graduatedPool ? { graduated: true, proof: Boolean(proof), signature: proof?.signature ?? market.graduationSignature, observedAt: proof?.recordedAt ?? null }
      : { graduated: false, config: configFor(market) },
  }, { now })
  const diversity = holderDiversity(trades, { labels, clusterOf, now })
  const retention = holderRetention(trades, { labels, clusterOf, launchAt: market.launchedAt ? new Date(market.launchedAt) : null, now })
  const liquidity = sustainedLiquidity(samples, { launchAt: market.launchedAt ? new Date(market.launchedAt) : null, now })
  const health = { diversity, retention, liquidity, builderReward: builderRewardAssessment({ liquidity, diversity, retention, organicPercent: integrity.organicPercent }) }
  let incentives = null
  if (market.graduatedPool) {
    const { rows: lpSamples } = await db.query(`select sampled_at as "sampledAt", position, owner, liquidity::text, permanent_locked_liquidity::text as "permanentLockedLiquidity",
        pool_liquidity::text as "poolLiquidity" from lp_position_samples where github_repo_id = $1 and sampled_at >= $2`, [repoId, new Date(now - INCENTIVE_WINDOW_DAYS * DAY)])
    incentives = lpIncentives(lpSamples, { labels, clusterOf, integrity,
      migratedPositions: new Set(proof ? [proof.creatorPosition, proof.partnerPosition] : []) })
  }
  return { ...quality, integrity: integrityView(integrity), health, incentives }
}

export async function storeReport(db, repoId, report) {
  await db.query(`insert into launch_quality_reports (github_repo_id, version, assessed_at, score, coverage_percent, report) values ($1, $2, $3, $4, $5, $6)
    on conflict (github_repo_id) do update set version = excluded.version, assessed_at = excluded.assessed_at, score = excluded.score,
      coverage_percent = excluded.coverage_percent, report = excluded.report`,
  [String(repoId), report.version, report.assessedAt, report.score, report.coveragePercent, JSON.stringify(report, (key, value) => (typeof value === 'bigint' ? value.toString() : value))])
}

export async function readStoredReport(db, repoId) {
  try {
    const { rows } = await db.query('select report from launch_quality_reports where github_repo_id = $1', [String(repoId)])
    return rows[0]?.report ?? null
  } catch (error) { if (missingTable(error)) return null; throw error }
}

export function createMarketTransparency({ pool, connection, resolveConfig, labelsFor = () => new Map(), holderSnapshot, pulseFor, launchFeeFor, feeClaimerFor,
  excluded = async () => new Set(), sampling = true, webhooks = null, now = Date.now, limits = TRANSPARENCY_LIMITS, log = () => {} }) {
  // A market whose sample or report keeps failing backs off (15 minutes, doubling to 6 hours) so it never takes the whole per-run
  // budget from the markets behind it. Held per process; a restart simply retries.
  const failures = new Map()
  const usable = (kind, market) => (failures.get(`${kind}:${market.githubRepoId}`)?.retryAt ?? 0) <= now()
  const failed = (kind, market) => {
    const key = `${kind}:${market.githubRepoId}`, count = (failures.get(key)?.count ?? 0) + 1
    if (failures.size >= 5000) failures.delete(failures.keys().next().value)
    failures.set(key, { count, retryAt: now() + Math.min(6 * 3_600_000, 15 * 60_000 * 2 ** (count - 1)) })
  }
  const due = async (kind, limit, everyMs) => (await dueMarkets(pool, { kind, limit: limit * 4, now: now(), everyMs }))
    .filter(market => usable(kind, market)).slice(0, limit)
  const step = async (name, result, work) => {
    try { result[name] = await work() }
    catch (error) { result[name] = { error: missingTable(error) ? 'NOT_MIGRATED' : String(error?.code ?? error?.name ?? 'error').slice(0, 40) } }
  }
  return {
    async runOnce() {
      const result = {}
      await step('schedules', result, () => reconcileSchedules(pool, now()))
      await step('feed', result, async () => produceFeedEvents(pool, { now: now(), excluded: await excluded() }))
      if (webhooks?.enabled) {
        await step('webhooks', result, async () => ({ ...await fanOutDeliveries(pool), ...await deliverDue(pool, { send: webhooks.send, key: webhooks.key, now }) }))
      }
      if (!sampling) return result
      await step('liquidity', result, async () => {
        const counts = { sampled: 0, failed: 0 }
        for (const market of await due('liquidity', limits.liquidityPerRun, limits.sampleEveryMs)) {
          try { await sampleMarketLiquidity(pool, market, { connection, resolveConfig, now: now() }); counts.sampled++; failures.delete(`liquidity:${market.githubRepoId}`) }
          catch (error) { counts.failed++; failed('liquidity', market); log({ liquiditySampleFailed: market.githubRepoId, code: String(error?.message ?? '').slice(0, 60) }) }
        }
        return counts
      })
      await step('lpPositions', result, async () => {
        const counts = { pools: 0, failed: 0 }
        for (const market of await due('lp', limits.lpPoolsPerRun, limits.sampleEveryMs)) {
          try { await sampleLpPositions(pool, market, { connection, now: now() }); counts.pools++; failures.delete(`lp:${market.githubRepoId}`) }
          catch { counts.failed++; failed('lp', market) }
        }
        return counts
      })
      await step('reports', result, async () => {
        const counts = { stored: 0, failed: 0 }
        for (const market of await due('reports', limits.reportsPerRun, limits.reportEveryMs)) {
          try {
            const report = await buildMarketReport(pool, market, { labels: labelsFor(market), holderSnapshot, pulseFor, launchFeeFor, feeClaimerFor,
              configFor: m => { try { return resolveConfig(m) } catch { return null } }, now: now() })
            await storeReport(pool, market.githubRepoId, report)
            counts.stored++
            failures.delete(`reports:${market.githubRepoId}`)
          } catch (error) { counts.failed++; failed('reports', market); log({ transparencyReportFailed: market.githubRepoId, code: String(error?.message ?? '').slice(0, 80) }) }
        }
        return counts
      })
      await step('pruned', result, async () => {
        const cutoff = new Date(now() - limits.retentionDays * DAY)
        const a = await pool.query('delete from market_liquidity_samples where id in (select id from market_liquidity_samples where sampled_at < $1 limit 5000)', [cutoff])
        const b = await pool.query('delete from lp_position_samples where id in (select id from lp_position_samples where sampled_at < $1 limit 5000)', [cutoff])
        return { samples: a.rowCount + b.rowCount }
      })
      return result
    },
  }
}
