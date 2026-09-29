import { PublicKey } from '@solana/web3.js'
import { createMarketConfigResolver } from './market-config.mjs'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, sql } from 'drizzle-orm'
import { markets, repoClaims } from './db/schema.mjs'

import { createGraduatedFees } from './graduated-fees.mjs'

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
            return { ...base, onchainCreatorFee, platform, status: 'MISMATCH', reason: 'Partner fee capture differs from chain evidence' }
        }
        if (graduated) {
          const { rows: [damm] } = await client.query(`select coalesce(sum(damm_amount_base_units),0)::text as paid
            from repo_claims where github_repo_id=$1 and status='settled'`,[String(repoId)])
          if (BigInt(damm.paid) !== graduated.claimed) return { ...base, onchainCreatorFee, platform, status: 'MISMATCH', reason: 'Graduated fee withdrawals differ from proven payouts' }
        }
        const difference = onchainCreatorFee - expectedRemaining
        return { ...base, onchainCreatorFee, platform, difference, graduated: Boolean(graduated),
          status: difference === 0n ? 'MATCH' : 'MISMATCH' }
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  return { reconcile }
}
