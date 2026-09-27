import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { markets } from './db/schema.mjs'

export function createLaunchIndexer({ pool, verify }) {
  const reconcileMarket = async market => {
    const result = await verify(market)
    if (result.state !== 'match') return result
    if (market.launchSlot !== null && market.launchSlot !== result.slot) {
      return { state: 'mismatch', reason: `Recorded slot ${market.launchSlot} differs from finalized slot ${result.slot}` }
    }
    if (market.launchFinality !== null && market.launchFinality !== result.finality) {
      return { state: 'mismatch', reason: 'Recorded finality contradicts chain evidence' }
    }
    if (market.discoveryVersion && (!result.blockTime || (market.launchBlockTime &&
        market.launchBlockTime.getTime() !== result.blockTime.getTime()))) {
      return { state: 'mismatch', reason: 'Discovery launch timestamp is unavailable or contradicts chain evidence' }
    }
    return result
  }
  const withMarketLock = async (repoId, callback) => {
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try { return await callback(drizzle(client)) }
      finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  const processMarket = async repoId => withMarketLock(repoId, async db => {
    const market = (await db.select().from(markets).where(eq(markets.githubRepoId, repoId)).limit(1))[0]
    if (!market) return { repoId: repoId.toString(), state: 'missing', reason: 'Database market disappeared' }
    if (!['confirmed', 'submitted', 'ambiguous'].includes(market.status)) {
      return { repoId: repoId.toString(), state: 'incomplete', reason: `Launch status is ${market.status}` }
    }
    const result = await reconcileMarket(market)
    if (result.state !== 'match') return { repoId: repoId.toString(), ...result }
    const now = new Date()
    const firstIndex = market.indexedAt === null
    await db.update(markets).set({
      status: 'confirmed', launchSlot: result.slot, launchFinality: result.finality,
      indexedAt: market.indexedAt ?? now, lastVerifiedAt: now,
      launchBlockTime: market.launchBlockTime ?? result.blockTime ?? null,
    }).where(eq(markets.id, market.id))
    return { repoId: repoId.toString(), state: market.status !== 'confirmed' ? 'recovered' : firstIndex ? 'indexed' : 'verified',
      slot: result.slot.toString(), finality: result.finality, marketId: market.id }
  })
  return {
    reconcileMarket,
    processMarket,
    async runOnce() {
      const db = drizzle(pool)
      const candidates = await db.select({ githubRepoId: markets.githubRepoId }).from(markets)
        .where(inArray(markets.status, ['confirmed', 'submitted', 'ambiguous']))
      const results = []
      for (const candidate of candidates) results.push(await processMarket(candidate.githubRepoId))
      return results
    },
  }
}
