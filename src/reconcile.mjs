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

// How long a ledger must stay unmatched, or unchecked, before it alerts: a failed read or a lagging RPC node clears within
// a pass or two.
export const RECONCILE_HOLD_MS = 15 * 60_000
// How long when all that was ever wrong is the chain ahead of the ledger (fees from trades the worker has not recorded
// yet). On the busiest market the worker records a trade's fees in a median 21 s and at most about 10 min, and trades
// overlap: over five days its ledger was behind without a break for 17 minutes once and for about 30 minutes once, never
// for an hour. A ledger behind for an hour means the indexer has stopped.
export const RECONCILE_BEHIND_HOLD_MS = 60 * 60_000
// A problem that persists is announced again once per period, so one missed or failed notification is not the last word.
export const RECONCILE_REPEAT_MS = 6 * 60 * 60_000
// An episode nobody has settled for this long is over: the passes were not reaching the ledger, and what they would have
// found is unknown. A pass must come round to each ledger more often than this, or nothing would ever last its hold; the
// graduation monitor already keeps a pass under half of PUBLIC_GRADUATION_MAX_AGE_MS (150 s) for the public curve state.
export const RECONCILE_STALE_MS = 10 * 60_000
// States that normally clear by themselves: the chain ahead of the ledger, a claim in flight, a read that failed. A pool
// that was read and is not this market's is none of those. Decides an alert's wording, not whether it is raised.
export const reconcileLagging = result => result?.status === 'PENDING_REVIEW' || (result?.status === 'UNAVAILABLE' && result.reason !== POOL_IDENTITY_MISMATCH) ||
  chainAheadOfLedger(result)

// When a ledger that stopped matching becomes an operator alert. settle(key, result) returns null, or
// { key, lagging, since } to alert on.
// - An episode runs from the first pass that does not MATCH to the next that does. Its state may change on the way (lag and
//   a real mismatch take turns on a trading market, a read fails now and then): it stays one episode.
// - It alerts holdMs after it first showed anything other than the chain being ahead of the ledger (a mismatch, a claim in
//   flight, a failed read), or once it has lasted behindHoldMs whatever it showed. From then on it alerts again once per
//   repeatMs for as long as it lasts. A ledger that matches again before that never alerts.
// - The key is the episode's start and its repeat period, so the caller's unique event key keeps one alert per period. A new
//   episode is a new alert.
// - Episodes live in this process. After a restart, a ledger that still does not match starts a new episode and alerts once
//   that has lasted its hold; since is when this process first saw it.
export function createReconcileEpisodes({ now = Date.now, holdMs = RECONCILE_HOLD_MS, behindHoldMs = Math.max(holdMs, RECONCILE_BEHIND_HOLD_MS),
  repeatMs = RECONCILE_REPEAT_MS, staleMs = RECONCILE_STALE_MS } = {}) {
  const episodes = new Map()
  return { settle(key, result) {
    if (result?.status === 'MATCH') { episodes.delete(key); return null }
    const at = now(), known = episodes.get(key)
    const episode = known && at - known.seen <= staleMs ? known : { first: at, otherFirst: null }
    episode.seen = at
    if (!chainAheadOfLedger(result)) episode.otherFirst ??= at
    episodes.set(key, episode)
    const due = at - episode.first >= behindHoldMs || (episode.otherFirst !== null && at - episode.otherFirst >= holdMs)
    if (!due) return null
    return { key: `${episode.first}:${Math.floor((at - episode.first) / repeatMs)}`, lagging: reconcileLagging(result), since: new Date(episode.first).toISOString() }
  } }
}

export function createReconciler({ pool, connection, config }) {
  const resolveConfig = createMarketConfigResolver(config)
  const graduatedFees = createGraduatedFees({ connection, config, db: pool })
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
        if (!state) return { ...base, status: 'UNAVAILABLE', reason: 'Canonical Meteora pool state is missing' }
        if (!state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(mintKey) ||
            !state.poolState.creator.equals(new PublicKey(market.creatorWallet))) {
          return { ...base, status: 'UNAVAILABLE', reason: POOL_IDENTITY_MISMATCH }
        }
        const graduated = await graduatedFees.read(market, state)
        const onchainCreatorFee = BigInt(state.poolState.creatorQuoteFee.toString()) + (graduated?.available ?? 0n)
        let platform = null
        if (graduated?.partner) {
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
