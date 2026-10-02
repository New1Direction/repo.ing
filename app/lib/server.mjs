import { cache } from 'react'
import { allocationEnabled } from '../../src/builder-allocation.mjs'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { createReconciler } from '../../src/reconcile.mjs'
import { createRpcMeter, registerRpcEndpoint } from '../../src/rpc-usage.mjs'
import { githubApiHeaders } from '../../src/github-app-auth.mjs'
import { ttlMemo } from './ttl-memo.mjs'
import { readGraduationRace } from './graduation-race.mjs'
import { marketRowStats } from './market-row-stats.mjs'
import { timed } from './server-timing.mjs'
import { hasEarnedPromotion, showsNewRepoLabel } from './repo-quality.mjs'
import { isOfficialLaunch } from './official-launch.mjs'
import { githubTime } from '../../src/github.mjs'

export function database() {
  if (!process.env.DATABASE_URL) return null
  if (!globalThis.__gitfunPool) globalThis.__gitfunPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  return globalThis.__gitfunPool
}

// One RPC meter per web process: a {"rpcUsage":…} line per minute while pages read the chain, and a provider
// answering HTTP 429 (rate limit or exhausted credits) is backed off instead of retried by every request.
function rpcFetchFor(url) {
  if (!globalThis.__repoingRpcMeter) {
    const meter = createRpcMeter()
    meter.report(60_000)
    globalThis.__repoingRpcMeter = { meter, fetch: meter.fetchFor('primary') }
    // Raw JSON-RPC reads (finalized-transaction.mjs) share the same meter and backoff.
    registerRpcEndpoint(url, globalThis.__repoingRpcMeter.fetch)
  }
  return globalThis.__repoingRpcMeter.fetch
}

export function chain() {
  if (!process.env.SOLANA_RPC_URL && process.env.NODE_ENV === 'production') throw new Error('SOLANA_RPC_URL is required in production')
  const url = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
  // The meter paces a rate-limited provider; web3.js's own 429 retries would only stack on top of it.
  return new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: rpcFetchFor(url) })
}

export function configAddress() { return process.env.DBC_CONFIG || null }

export function creatorSigner() {
  const value = process.env.PLATFORM_CREATOR_SECRET_KEY
  if (!value) return null
  const bytes = value.trim().startsWith('[') ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value)
  return Keypair.fromSecretKey(bytes)
}

export function partnerSigner() {
  const value = process.env.PLATFORM_PARTNER_SECRET_KEY
  if (!value) return null
  return Keypair.fromSecretKey(value.trim().startsWith('[') ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value))
}
export function discoveryRewardsEnabled() {
  return process.env.DISCOVERY_REWARDS_ENABLED === 'true' && Boolean(process.env.PLATFORM_PARTNER_SECRET_KEY)
}

export function builderAllocationEnabled() { return allocationEnabled(configAddress()) }

export function launchAvailable() { return Boolean(database() && configAddress() && creatorSigner()) }
export function tradeAvailable() { return Boolean(database() && configAddress()) }

// Home, /explore and the wallet overview render per request; share one market aggregate per 15 s.
const MARKETS_TTL_MS = 15_000
export const listMarkets = ttlMemo(() => timed('listMarkets', loadMarkets), MARKETS_TTL_MS, { keep: result => !result.unavailable })

// Repository quality (repo-quality.mjs) and the Official mark from a market row's own columns. A recorded migration counts
// as graduated for promotion even while the fresh progress read is stale. newRepo: the market shows the "New repo" label
// (a new repository that has not earned promotion yet).
function withSignals(market, migrated, now) {
  const facts = { ...market, graduated: market.graduated || migrated }
  return { ...market, newRepo: showsNewRepoLabel(facts, now), promoted: hasEarnedPromotion(facts, now), officialLaunch: isOfficialLaunch(market) }
}

// 24h volume: bonding-curve swaps, plus swaps in the DAMM v2 pool a graduated market's verified migration names (the
// binding /stats uses: events recorded under any other pool never count).
async function loadMarkets() {
  const pool = database()
  if (!pool) return { markets: [], unavailable: 'Database is not configured.' }
  try {
    const { rows } = await pool.query(`
      select m.github_repo_id::text as "repoId", m.mint, m.pool, m.token_name as "tokenName",
        m.token_symbol as "symbol", m.indexed_at as "indexedAt", m.builder_allocation_version as "allocationVersion", m.discovery_version as "discoveryVersion", m.launcher_wallet as "launcherWallet", r.owner, r.name,
        r.full_name as "fullName", r.description, r.avatar_url as "avatarUrl", r.stars, r.forks, r.github_created_at as "githubCreatedAt",
        coalesce(f.earned, 0)::text as "earned", coalesce(c.claimed, 0)::text as "claimed",
        (coalesce(t.volume, 0) + coalesce(dv.volume, 0))::text as "volume24hLamports",
        b.wallet as "beneficiaryWallet", b.method as "beneficiaryMethod", exists (
          select 1 from repo_verifications v where v.github_repo_id = m.github_repo_id and v.permission = 'admin'
        ) as "wasVerified",
        case when coalesce(dp.slot, -1) > coalesce(cp.slot, -1) then dp.next_sqrt_price else cp.next_sqrt_price end as "lastSqrtPrice",
        o.status as "graduationStatus", o.observation, o.error_code as "graduationError", e.evidence_hash as "migrationEvidenceHash"
      from markets m join repositories r on r.github_repo_id = m.github_repo_id
      left join (select distinct on (pool) pool, slot, next_sqrt_price from trade_events
        order by pool, slot desc, event_index desc) cp on cp.pool = m.pool
      left join (select distinct on (github_repo_id) github_repo_id, slot, next_sqrt_price from damm_trade_events
        where next_sqrt_price is not null order by github_repo_id, slot desc, event_index desc) dp on dp.github_repo_id = m.github_repo_id
      left join graduation_observations o on o.github_repo_id = m.github_repo_id
      left join graduation_events e on e.github_repo_id = m.github_repo_id
      left join (select github_repo_id, sum(amount_base_units) earned from builder_fee_credits group by github_repo_id) f on f.github_repo_id = m.github_repo_id
      left join (select github_repo_id, sum(amount_base_units) claimed from repo_claims where status = 'settled' group by github_repo_id) c on c.github_repo_id = m.github_repo_id
      left join repo_beneficiaries b on b.github_repo_id = m.github_repo_id
      left join (select pool, sum((case when direction = 'buy' then input_base_units else output_base_units end)::numeric) as volume
        from trade_events where traded_at >= now() - interval '24 hours' group by pool) t on t.pool = m.pool
      left join (select d.github_repo_id, sum(d.quote_amount) as volume from damm_trade_events d
        join graduation_events g on g.github_repo_id = d.github_repo_id and g.pool = d.pool
        where d.traded_at >= now() - interval '24 hours' group by d.github_repo_id) dv on dv.github_repo_id = m.github_repo_id
      where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'
      order by m.indexed_at desc`)
    const now = Date.now()
    return { markets: rows.map(({ lastSqrtPrice, graduationStatus, observation, graduationError, migrationEvidenceHash, ...row }) => withSignals({ ...row,
      stars: Number(row.stars), forks: Number(row.forks),
      earned: row.earned, claimed: row.claimed, remaining: (BigInt(row.earned) - BigInt(row.claimed)).toString(),
      ...marketRowStats({ lastSqrtPrice, graduationStatus, observation, graduationError, migrationEvidenceHash }, now) }, Boolean(migrationEvidenceHash), now)) }
  } catch { return { markets: [], unavailable: 'Markets are temporarily unavailable.' } }
}

// Home, /explore and the $REPOING page: every curve market ranked by verified graduation progress (one joined read;
// freshness is checked per row). Callers take the top they need.
const GRADUATION_RACE_TTL_MS = 30_000
export const graduationRace = ttlMemo(() => timed('graduationRace', loadGraduationRace), GRADUATION_RACE_TTL_MS, { keep: result => !result.unavailable })

async function loadGraduationRace() {
  const pool = database()
  if (!pool) return { markets: [], unavailable: 'Database is not configured.' }
  try { return { markets: await readGraduationRace(pool) } }
  catch { return { markets: [], unavailable: 'Graduation progress is temporarily unavailable.' } }
}

export async function recentBuilderPayouts() {
  const pool = database()
  if (!pool) return { payouts: [], unavailable: true }
  try {
    const { rows } = await pool.query(`select c.claim_signature as signature, c.amount_base_units::text as amount,
      c.settled_at as "settledAt", m.mint, r.full_name as "fullName"
      from repo_claims c join markets m on m.github_repo_id=c.github_repo_id
      join repositories r on r.github_repo_id=c.github_repo_id
      where c.status='settled' and c.settled_at is not null and c.amount_base_units>0
      and m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'
      order by c.settled_at desc, c.id desc limit 10`)
    return { payouts: rows, unavailable: false }
  } catch { return { payouts: [], unavailable: true } }
}

export async function protocolStats() {
  const pool = database()
  if (!pool) return { stats: null, unavailable: 'Protocol stats are unavailable.' }
  try {
    const { rows } = await pool.query(`
      select m.markets as "markets", t.trades as "trades", t.volume as "volumeLamports",
        f.earned as "earnedLamports", c.paid as "paidLamports"
      from (select count(*)::text as markets from markets
        where status = 'confirmed' and indexed_at is not null and launch_finality = 'finalized') m
      cross join (select count(*)::text as trades,
        coalesce(sum((case when t.direction = 'buy' then t.input_base_units else t.output_base_units end)::numeric), 0)::text as volume
        from trade_events t join markets market on market.pool = t.pool
        where market.status = 'confirmed' and market.indexed_at is not null and market.launch_finality = 'finalized') t
      cross join (select coalesce(sum(f.amount_base_units), 0)::text as earned
        from builder_fee_credits f join markets market on market.pool = f.pool
        where market.status = 'confirmed' and market.indexed_at is not null and market.launch_finality = 'finalized') f
      cross join (select coalesce(sum(c.amount_base_units), 0)::text as paid
        from repo_claims c join markets market on market.github_repo_id = c.github_repo_id
        where c.status = 'settled' and market.status = 'confirmed'
          and market.indexed_at is not null and market.launch_finality = 'finalized') c`)
    return { stats: rows[0] ?? null, unavailable: null }
  } catch { return { stats: null, unavailable: 'Protocol stats are temporarily unavailable.' } }
}

// Filter the canonical market first. These aggregates only read evidence for that market.
async function singleMarket(column, value) {
  const pool = database()
  if (!pool) return { market: null, unavailable: 'Database is not configured.' }
  try {
    const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.pool,
      m.token_name as "tokenName", m.token_symbol as symbol, m.indexed_at as "indexedAt",
      m.builder_allocation_version as "allocationVersion", m.discovery_version as "discoveryVersion", m.launcher_wallet as "launcherWallet",
      m.verification_bonus_lamports::text as "verificationBonusLamports",
      r.owner, r.name, r.full_name as "fullName", r.description, r.avatar_url as "avatarUrl",
      r.stars, r.forks, r.github_updated_at as "updatedAt", r.github_created_at as "githubCreatedAt", b.wallet as "beneficiaryWallet", b.bound_at as "beneficiaryBoundAt", b.method as "beneficiaryMethod",
      (select coalesce(sum(amount_base_units), 0)::text from builder_fee_credits where github_repo_id = m.github_repo_id) as earned,
      (select coalesce(sum(amount_base_units), 0)::text from repo_claims where github_repo_id = m.github_repo_id and status = 'settled') as claimed,
      ((select coalesce(sum((case when direction = 'buy' then input_base_units else output_base_units end)::numeric), 0)
        from trade_events where pool = m.pool and traded_at >= now() - interval '24 hours')
      + (select coalesce(sum(d.quote_amount), 0) from damm_trade_events d join graduation_events g on g.github_repo_id = d.github_repo_id and g.pool = d.pool
        where d.github_repo_id = m.github_repo_id and d.traded_at >= now() - interval '24 hours'))::text as "volume24hLamports",
      exists(select 1 from repo_verifications where github_repo_id = m.github_repo_id and permission = 'admin') as "wasVerified",
      case when coalesce(dp.slot, -1) > coalesce(cp.slot, -1) then dp.next_sqrt_price else cp.next_sqrt_price end as "lastSqrtPrice",
      o.status as "graduationStatus", o.observation, o.error_code as "graduationError", e.evidence_hash as "migrationEvidenceHash"
      from markets m join repositories r on r.github_repo_id = m.github_repo_id
      left join repo_beneficiaries b on b.github_repo_id = m.github_repo_id
      left join lateral (select slot, next_sqrt_price from trade_events where pool = m.pool
        order by slot desc, event_index desc limit 1) cp on true
      left join lateral (select slot, next_sqrt_price from damm_trade_events where github_repo_id = m.github_repo_id
        and next_sqrt_price is not null order by slot desc, event_index desc limit 1) dp on true
      left join graduation_observations o on o.github_repo_id = m.github_repo_id
      left join graduation_events e on e.github_repo_id = m.github_repo_id
      where m.${column} = $1 and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'`, [value])
    const [row] = rows
    if (!row) return { market: null }
    // Same row fields as the market list (price, bonding progress, quality signals), so either read can back a market card.
    const { lastSqrtPrice, graduationStatus, observation, graduationError, migrationEvidenceHash, ...market } = row
    const now = Date.now()
    return { market: withSignals({ ...market, stars: Number(market.stars), forks: Number(market.forks),
      remaining: (BigInt(market.earned) - BigInt(market.claimed)).toString(),
      ...marketRowStats({ lastSqrtPrice, graduationStatus, observation, graduationError, migrationEvidenceHash }, now) }, Boolean(migrationEvidenceHash), now) }
  } catch { return { market: null, unavailable: 'Market is temporarily unavailable.' } }
}
// React cache is scoped to the render: metadata and page share one read, without caching payout state.
export const marketByMint = cache(mint => timed('market', () => singleMarket('mint', mint)))
export const marketByRepo = cache(repoId => /^\d+$/.test(String(repoId))
  ? timed('market', () => singleMarket('github_repo_id', String(repoId))) : Promise.resolve({ market: null }))

export async function repositoryById(repoId) {
  if (!/^\d+$/.test(String(repoId))) return null
  const pool = database()
  let row = null
  if (pool) {
    try {
      const result = await pool.query('select github_repo_id::text as "repoId", owner, name, full_name as "fullName", description, avatar_url as "avatarUrl", stars, forks, github_updated_at as "updatedAt", github_created_at as "githubCreatedAt" from repositories where github_repo_id = $1', [repoId])
      row = result.rows[0] ?? null
    } catch { /* GitHub may still resolve the repository. */ }
  }
  try {
    const githubHeaders = await githubApiHeaders('repo.ing-ui')
    const response = await fetch(`https://api.github.com/repositories/${repoId}`, { headers: githubHeaders, cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!response.ok) return row
    const repo = await response.json()
    if (String(repo.id) !== String(repoId) || repo.private || repo.archived) return row
    const detailResponse = repo.language !== undefined && repo.license !== undefined ? null : await fetch(`https://api.github.com/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`, { headers: githubHeaders, cache: 'no-store', signal: AbortSignal.timeout(5000) })
    const detail = detailResponse?.ok ? await detailResponse.json() : repo
    return { repoId: String(repo.id), owner: repo.owner.login, name: repo.name, fullName: repo.full_name,
      description: repo.description, avatarUrl: repo.owner.avatar_url, stars: repo.stargazers_count,
      forks: repo.forks_count, language: detail.language ?? null, license: detail.license?.spdx_id ?? null,
      updatedAt: repo.updated_at, htmlUrl: repo.html_url, hasIssues: typeof repo.has_issues === 'boolean' ? repo.has_issues : null,
      githubCreatedAt: githubTime(repo.created_at)?.toISOString() ?? row?.githubCreatedAt ?? null }
  } catch { return row }
}

export async function feeStatus(repoId) {
  const pool = database()
  const config = configAddress()
  if (!pool || !config) return { status: 'UNAVAILABLE', onchainCreatorFee: null }
  try { return await createReconciler({ pool, connection: chain(), config }).reconcile(repoId) }
  catch { return { status: 'UNAVAILABLE', onchainCreatorFee: null } }
}

// Token pages display fee status on every view; one chain reconciliation per repository per 30 s (10 s while it is
// unavailable) serves every viewer of this process. Claim and payout paths call feeStatus and always read fresh.
const DISPLAY_FEE_STATUS_MS = 30_000
const DISPLAY_FEE_UNAVAILABLE_MS = 10_000
const displayFeeStatuses = new Map()
export function displayFeeStatus(repoId, { now = Date.now, read = feeStatus } = {}) {
  const key = String(repoId), hit = displayFeeStatuses.get(key)
  if (hit?.pending) return hit.pending
  if (hit && now() < hit.expiresAt) return Promise.resolve(hit.value)
  const pending = read(key).then(value => {
    if (displayFeeStatuses.size >= 500) displayFeeStatuses.delete(displayFeeStatuses.keys().next().value)
    displayFeeStatuses.set(key, { value, expiresAt: now() + (value?.status === 'UNAVAILABLE' ? DISPLAY_FEE_UNAVAILABLE_MS : DISPLAY_FEE_STATUS_MS) })
    return value
  }, error => { displayFeeStatuses.delete(key); throw error })
  displayFeeStatuses.set(key, { pending })
  return pending
}
