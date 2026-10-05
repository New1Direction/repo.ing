import { createHash, randomBytes } from 'node:crypto'
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
// States that may be a moment's lag: the chain ahead of the ledger, a claim in flight, a read that failed.
export const reconcileLagging = result => ['PENDING_REVIEW', 'UNAVAILABLE'].includes(result?.status) || chainAheadOfLedger(result)

// The kind of a mismatch, without its amounts: its reason, and which way the creator and partner sides differ. A persistent
// mismatch keeps its kind while trades move the amounts, so it alerts once, not on every pass.
const sign = value => value === null ? '?' : value > 0n ? '+' : value < 0n ? '-' : '0'
const gap = (onchain, ledger) => { const a = amount(onchain), b = amount(ledger); return a === null || b === null ? null : a - b }
export function reconcileMismatchKind(result) {
  const platform = result.platform ? sign(gap(result.platform.onchainEarned, result.platform.earned)) + sign(gap(result.platform.onchainClaimed, result.platform.claimed)) : ''
  return [result.status, result.reason ?? '', sign(amount(result.difference)), platform].join(':')
}

// One operator alert per episode (the model of the stock reconciler's runner, src/stock-reconcile.mjs). An episode starts
// when a ledger stops matching: a lagging state alerts once if it lasts lagMs, a real mismatch alerts at once, and a
// mismatch of another kind starts a new episode. A MATCH ends it. settle returns null, or what to alert on: a key that
// stays the same for the whole episode, whether it is lag, and when it began. Episodes live in this process; a restart
// begins new ones, so a mismatch that survives a deploy is reported again.
export function createReconcileEpisodes({ now = Date.now, lagMs = RECONCILE_LAG_MS } = {}) {
  const episodes = new Map(), run = randomBytes(6).toString('hex')
  let sequence = 0
  return { settle(key, result, kindOf = reconcileMismatchKind) {
    if (result?.status === 'MATCH') { episodes.delete(key); return null }
    const lagging = reconcileLagging(result), kind = lagging ? 'lagging' : kindOf(result)
    let episode = episodes.get(key)
    if (episode?.kind !== kind) episodes.set(key, episode = { kind, first: now(), id: ++sequence })
    if (lagging && now() - episode.first < lagMs) return null
    return { key: `episode:${createHash('sha256').update(JSON.stringify([run, kind, episode.first, episode.id])).digest('hex').slice(0, 32)}`,
      lagging, since: new Date(episode.first).toISOString() }
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
        if (!state || !state.poolState.config.equals(configKey) ||
            !state.poolState.baseMint.equals(mintKey) ||
            !state.poolState.creator.equals(new PublicKey(market.creatorWallet))) {
          return { ...base, status: 'UNAVAILABLE', reason: 'Canonical Meteora pool state is missing or inconsistent' }
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
