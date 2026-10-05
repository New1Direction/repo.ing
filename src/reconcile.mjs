import { createHash } from 'node:crypto'
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

// How long a state that may be a moment's lag is held before it alerts (the stock reconciler's STOCK_RECONCILE_LAG_MS).
// After a trade the worker records its fees in a median ~30 s, up to ~10 min.
export const RECONCILE_LAG_MS = 15 * 60_000
// A problem that persists is announced again once per period, so one missed or failed notification is not the last word.
export const RECONCILE_REPEAT_MS = 6 * 60 * 60_000
// An episode nobody has observed for this long is over: the market's passes were failing before they reached its ledger.
export const RECONCILE_STALE_MS = 10 * 60_000
// States that may be a moment's lag: the chain ahead of the ledger, a claim in flight, a read that failed. A pool that was
// read and is not this market's is none of those.
export const reconcileLagging = result => result?.status === 'PENDING_REVIEW' || (result?.status === 'UNAVAILABLE' && result.reason !== POOL_IDENTITY_MISMATCH) ||
  chainAheadOfLedger(result)

// The kind of a mismatch, without its amounts: its reason, and which way the creator and partner sides differ. A persistent
// mismatch keeps its kind while trades move the amounts.
const sign = value => value === null ? '?' : value > 0n ? '+' : value < 0n ? '-' : '0'
const gap = (onchain, ledger) => { const a = amount(onchain), b = amount(ledger); return a === null || b === null ? null : a - b }
export function reconcileMismatchKind(result) {
  const platform = result.platform ? sign(gap(result.platform.onchainEarned, result.platform.earned)) + sign(gap(result.platform.onchainClaimed, result.platform.claimed)) : ''
  return [result.status, result.reason ?? '', sign(amount(result.difference)), platform].join(':')
}

// When a ledger that stopped matching becomes an operator alert (the model of the stock reconciler's runner,
// src/stock-reconcile.mjs). settle(key, result) returns null, or { key, lagging, since } to alert on.
// - An episode runs from the first pass that does not MATCH to the next that does.
// - A lagging state alerts only once it has lasted lagMs. A real mismatch alerts at once, and from then on lag in the same
//   episode adds nothing: on a trading market a real mismatch and a moment's lag take turns from pass to pass.
// - The alert's key names the kind of mismatch and the repeat period it falls in, nothing else. So trades moving the
//   amounts, the state flickering, a restarted worker and a second worker all raise the same alert (the caller's unique
//   event key keeps one row), and a problem that persists is announced again once per repeatMs.
// - Episodes live in this process. A restart begins the lag hold again; it never repeats an alert.
export function createReconcileEpisodes({ now = Date.now, lagMs = RECONCILE_LAG_MS, repeatMs = RECONCILE_REPEAT_MS, staleMs = RECONCILE_STALE_MS } = {}) {
  const episodes = new Map()
  return { settle(key, result, kindOf = reconcileMismatchKind) {
    if (result?.status === 'MATCH') { episodes.delete(key); return null }
    const at = now()
    let episode = episodes.get(key)
    if (!episode || at - episode.seen > staleMs) episodes.set(key, episode = { first: at, lagFirst: null, real: false })
    episode.seen = at
    const lagging = reconcileLagging(result)
    if (lagging) {
      if (episode.real) return null
      episode.lagFirst ??= at
      if (at - episode.lagFirst < lagMs) return null
    } else episode.real = true
    const kind = createHash('sha256').update(lagging ? 'lagging' : kindOf(result)).digest('hex').slice(0, 16)
    return { key: `${lagging ? 'lagging' : 'mismatch'}:${kind}:${Math.floor(at / repeatMs)}`, lagging,
      since: new Date(lagging ? episode.lagFirst : episode.first).toISOString() }
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
