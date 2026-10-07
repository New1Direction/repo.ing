import { isBundleMarket } from './bundles.mjs'
import { PublicKey } from '@solana/web3.js'
import { createMarketConfigResolver } from './market-config.mjs'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, sql } from 'drizzle-orm'
import { markets, repoClaims } from './db/schema.mjs'

import { createGraduatedFees } from './graduated-fees.mjs'

export const PARTNER_CAPTURE_MISMATCH = 'Partner fee capture differs from chain evidence'
export const GRADUATED_WITHDRAWAL_MISMATCH = 'Graduated fee withdrawals differ from proven payouts'
// The pool read succeeded, and it is not this market's pool: another config, mint or creator than the market records.
export const POOL_IDENTITY_MISMATCH = 'Canonical Meteora pool does not match the market'
// The pool read succeeded, and the chain has no such pool.
export const POOL_STATE_MISSING = 'Canonical Meteora pool state is missing'

const amount = value => { try { return value == null ? null : BigInt(value) } catch { return null } }

// A MISMATCH that only means the chain is ahead of the indexed ledger: fees from trades the worker has not recorded
// yet. On-chain creator fees above what the ledger expects, and partner fees earned on-chain at or above those captured
// with the same amounts claimed. A ledger ahead of the chain, a claim or withdrawal difference, or any other status
// (a pending claim, unavailable) is not.
export function chainAheadOfLedger(result) {
  if (result?.status !== 'MISMATCH') return false
  const platform = result.platform ?? null
  if (platform) {
    const [earned, claimed, onchainEarned, onchainClaimed] = [platform.earned, platform.claimed, platform.onchainEarned, platform.onchainClaimed].map(amount)
    if ([earned, claimed, onchainEarned, onchainClaimed].includes(null) || claimed !== onchainClaimed || onchainEarned < earned) return false
    if (result.reason === PARTNER_CAPTURE_MISMATCH) {
      // Returned before the creator comparison: the creator side must not be behind either.
      const onchain = amount(result.onchainCreatorFee), expected = amount(result.expectedRemaining)
      return onchainEarned > earned && onchain !== null && expected !== null && onchain >= expected
    }
  }
  if (result.reason) return false
  const difference = amount(result.difference)
  return difference !== null && difference > 0n
}

// What one pass found, for the holds below.
// - behind: the chain ahead of the ledger. Fees from trades the worker has not recorded yet; normal after a trade.
// - unchecked: no comparison was made. A read failed, a claim is in flight, or the pass failed before it got that far.
// - difference: anything else a completed check found, and a pool that is missing or is not the market's.
const FOUND_BY_THE_READ = [POOL_IDENTITY_MISMATCH, POOL_STATE_MISSING]
export const reconcileKind = result => chainAheadOfLedger(result) ? 'behind'
  : result?.status === 'PENDING_REVIEW' || result?.status === 'ERROR' || (result?.status === 'UNAVAILABLE' && !FOUND_BY_THE_READ.includes(result.reason)) ? 'unchecked'
  : 'difference'
// States that normally clear by themselves: the chain ahead of the ledger, a claim in flight, a read that failed. Decides an
// alert's wording, not whether it is raised.
export const reconcileLagging = result => result?.status === 'PENDING_REVIEW' || (result?.status === 'UNAVAILABLE' && !FOUND_BY_THE_READ.includes(result.reason)) ||
  chainAheadOfLedger(result)

// How long a difference, or a run of passes that could not check, must last before it alerts: one failed read or one read
// from a lagging RPC node clears within a pass or two.
export const RECONCILE_HOLD_MS = 15 * 60_000
// How long a ledger may stay behind the chain with nothing new recorded for it. Measured on the busiest market over five
// days (3,851 swaps): the worker recorded a trade's fees in a median 21 s and at most about 10 min. A ledger that is behind
// and has not moved for an hour is not catching up: the indexer stopped, or missed a trade.
export const RECONCILE_BEHIND_HOLD_MS = 60 * 60_000
// How long a ledger may stay behind, without one matching pass, while it keeps recording. A market traded without a pause
// is behind on every pass and still healthy; over those five days the longest such stretch was about 30 minutes.
export const RECONCILE_BEHIND_MAX_MS = 6 * 60 * 60_000
// A problem that persists is announced again once per period, so one missed or failed notification is not the last word.
export const RECONCILE_REPEAT_MS = 6 * 60 * 60_000
// An episode nobody has settled for this long is over: nothing was watching the ledger, and what it did meanwhile is
// unknown. Well above any pass a slow provider can cause, so slow passes stay one episode. The graduation monitor also
// ends an episode that its passes stopped reaching (src/ledger-alerts.mjs).
export const RECONCILE_STALE_MS = 60 * 60_000

// The ledger's side of a fee reconciliation: what the worker has recorded so far. It moves whenever fees are recorded.
const recordedSoFar = result => `${result.recordedEarned ?? ''}|${result.platform?.earned ?? ''}`

// When a ledger that stopped matching becomes an operator alert. settle(key, result) returns null, or
// { key, kind, repeat, lagging, stalled, since } to alert on. forget(key) ends an episode without a match.
// - An episode runs from the first pass that does not MATCH to the next that does.
// - What a pass found has its own hold, by kind (reconcileKind):
//   - difference: seen again holdMs or more after it was first seen in the episode. Lag may hide it on the passes between.
//   - unchecked: holdMs without one pass that completed a check. Any completed check starts the count again.
//   - behind: behindHoldMs with nothing new recorded for the ledger (stalled), or still behind behindMaxMs after the pass
//     that first found it behind, with no matching pass since.
// - The key is the episode's start, the kind and the repeat period, so the caller's unique event key keeps one alert per
//   kind per period. A problem that changes kind (reads fail, then a real difference shows) is announced as the new kind.
//   repeat: this kind was already due in an earlier period of the episode.
// - Episodes live in this process. After a restart, a ledger that still does not match starts a new episode and alerts once
//   that has lasted its hold; since is when this process first saw it.
export function createReconcileEpisodes({ now = Date.now, holdMs = RECONCILE_HOLD_MS, behindHoldMs = Math.max(holdMs, RECONCILE_BEHIND_HOLD_MS),
  behindMaxMs = Math.max(behindHoldMs, RECONCILE_BEHIND_MAX_MS), repeatMs = RECONCILE_REPEAT_MS, staleMs = RECONCILE_STALE_MS } = {}) {
  const episodes = new Map()
  // Whether what this pass found has gone on long enough.
  function due(episode, kind, result, at) {
    // A pass that compared the ledger with the chain ends any run of passes that could not.
    if (kind !== 'unchecked') episode.unchecked = null
    if (kind === 'difference') return at - (episode.difference ??= at) >= holdMs
    if (kind === 'unchecked') return at - (episode.unchecked ??= at) >= holdMs
    const recorded = recordedSoFar(result)
    if (recorded !== episode.recorded) { episode.recorded = recorded; episode.moved = at }
    // No other kind of pass starts the six hours again: one stale read in six hours must not keep a ledger that stays behind quiet.
    return at - episode.moved >= behindHoldMs || at - (episode.behind ??= at) >= behindMaxMs
  }
  return {
    settle(key, result) {
      if (result?.status === 'MATCH') { episodes.delete(key); return null }
      const at = now(), known = episodes.get(key)
      const episode = known && at - known.seen <= staleMs ? known : { first: at, difference: null, unchecked: null, behind: null, recorded: null, moved: at, firstDue: {} }
      episode.seen = at
      episodes.set(key, episode)
      const kind = reconcileKind(result)
      if (!due(episode, kind, result, at)) return null
      const period = Math.floor((at - episode.first) / repeatMs)
      return { key: `${episode.first}:${kind}:${period}`, kind, repeat: period > (episode.firstDue[kind] ??= period), lagging: reconcileLagging(result),
        stalled: kind === 'behind' && at - episode.moved >= behindHoldMs, since: new Date(episode.first).toISOString() }
    },
    forget(key) { episodes.delete(key) },
  }
}

// earlyAccess (EARLY_ACCESS_DBC_CONFIG), passed only by a path that handles them: a contributor early access market's builder fees
// are reconciled on its curve like any other's (docs/EARLY_ACCESS.md, step 6a). Without it (every other caller, the fee status the
// token page and the claim preview read included) such a market is refused by name.
// earlyAccessGraduated: the caller also handles a graduated early access market (the graduation monitor; step 7).
export function createReconciler({ pool, connection, config, earlyAccess = null, earlyAccessGraduated = false }) {
  const resolveConfig = createMarketConfigResolver(config, undefined, undefined, { earlyAccess })
  const graduatedFees = createGraduatedFees({ connection, config, db: pool, earlyAccess, earlyAccessGraduated })
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')

  const reconcile = async githubRepoId => {
    const repoId = BigInt(githubRepoId)
    if (repoId <= 0n) throw new Error('GitHub repository ID must be positive')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try {
        const db = drizzle(client)
        const [market] = await db.select().from(markets).where(eq(markets.githubRepoId, repoId)).limit(1)
        if (!market || market.status !== 'confirmed' || !market.indexedAt || market.launchFinality !== 'finalized') {
          throw new Error('Repository has no indexed canonical market')
        }
        const mintKey = new PublicKey(market.mint)
        const configKey = resolveConfig(market)
        const poolKey = new PublicKey(market.pool)
        if (!deriveDbcPoolAddress(NATIVE_MINT, mintKey, configKey).equals(poolKey)) {
          throw new Error('Canonical market does not match fixed DBC config')
        }
        const { rows: [credits] } = await client.query('select coalesce(sum(amount_base_units),0)::text as total from builder_fee_credits where github_repo_id=$1',[String(repoId)])
        const [claims] = await db.select({ pending: sql`count(*) filter (where ${repoClaims.status} = 'pending')::int` })
          .from(repoClaims).where(eq(repoClaims.githubRepoId, repoId))
        const [settled] = await db.select({ total: sql`coalesce(sum(${repoClaims.amountBaseUnits}), 0)::text` })
          .from(repoClaims).where(sql`${repoClaims.githubRepoId} = ${repoId} and ${repoClaims.status} = 'settled'`)
        const recordedEarned = BigInt(credits.total)
        const recordedClaimed = BigInt(settled.total)
        const expectedRemaining = recordedEarned - recordedClaimed
        const base = { githubRepoId: repoId, pool: market.pool, recordedEarned, recordedClaimed,
          expectedRemaining, onchainCreatorFee: null, difference: null }
        if (Number(claims.pending) > 0) return { ...base, status: 'PENDING_REVIEW',
          reason: `${claims.pending} unresolved claim intent(s)` }

        let state
        try {
          state = await dbc.state.getPool(poolKey)
        } catch (error) {
          return { ...base, status: 'UNAVAILABLE', reason: `Meteora pool read failed: ${error.message}` }
        }
        if (!state) return { ...base, status: 'UNAVAILABLE', reason: POOL_STATE_MISSING }
        if (!state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(mintKey) ||
            !state.poolState.creator.equals(new PublicKey(market.creatorWallet))) {
          return { ...base, status: 'UNAVAILABLE', reason: POOL_IDENTITY_MISMATCH }
        }
        const graduated = await graduatedFees.read(market, state)
        const onchainCreatorFee = BigInt(state.poolState.creatorQuoteFee.toString()) + (graduated?.available ?? 0n)
        let platform = null
        // A bundle market's partner position is the bundle router's (docs/BUNDLE_LAUNCH.md): repo.ing's platform ledgers never
        // book it, so they are not compared with it.
        if (graduated?.partner && !isBundleMarket(market)) {
          const { rows: [events] } = await client.query(`select coalesce(sum(amount_base_units),0)::text as earned
            from platform_fee_events where github_repo_id=$1`, [String(repoId)])
          const { rows: [paid] } = await client.query(`select coalesce(sum(amount),0)::text as paid
            from platform_fee_claims where github_repo_id=$1 and phase='DAMM' and status='settled'`, [String(repoId)])
          platform = { earned: BigInt(events.earned), claimed: BigInt(paid.paid),
            onchainEarned: graduated.partner.earned, onchainClaimed: graduated.partner.claimed }
          if (platform.earned !== platform.onchainEarned || platform.claimed !== platform.onchainClaimed)
            return { ...base, onchainCreatorFee, platform, status: 'MISMATCH', reason: PARTNER_CAPTURE_MISMATCH }
        }
        if (graduated) {
          const { rows: [damm] } = await client.query(`select coalesce(sum(damm_amount_base_units),0)::text as paid
            from repo_claims where github_repo_id=$1 and status='settled'`,[String(repoId)])
          if (BigInt(damm.paid) !== graduated.claimed) return { ...base, onchainCreatorFee, platform, status: 'MISMATCH', reason: GRADUATED_WITHDRAWAL_MISMATCH }
        }
        const difference = onchainCreatorFee - expectedRemaining
        return { ...base, onchainCreatorFee, platform, difference, graduated: Boolean(graduated),
          status: difference === 0n ? 'MATCH' : 'MISMATCH' }
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  return { reconcile }
}
