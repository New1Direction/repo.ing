import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { markets } from './db/schema.mjs'
import { usesActivationClock } from './launch-clock.mjs'
import { EXPIRY_MARKET_COLUMNS, releaseExpiredLaunch } from './launch-expiry.mjs'

export const settledLaunch = market => market.status === 'confirmed' && market.indexedAt !== null && market.launchFinality === 'finalized'

// Launches still settling (submitted, ambiguous, or confirmed but not yet indexed as finalized) are verified every
// run. An indexed finalized launch rests on immutable chain evidence, so it is re-checked only once its
// last_verified_at is reverifyAfterMs old, at most maxReverify per run (oldest first), and not before retryAt.
export function launchesToVerify(candidates, { now = Date.now(), reverifyAfterMs, maxReverify = 5, retryAt = new Map() }) {
  const stale = market => !market.lastVerifiedAt || now - market.lastVerifiedAt.getTime() >= reverifyAfterMs
  const reverify = candidates.filter(market => settledLaunch(market) && stale(market) && !((retryAt.get(market.githubRepoId.toString()) ?? 0) > now))
    .sort((a, b) => (a.lastVerifiedAt?.getTime() ?? 0) - (b.lastVerifiedAt?.getTime() ?? 0)).slice(0, maxReverify)
  return [...candidates.filter(market => !settledLaunch(market)), ...reverify]
}

// reverifyAfterMs (worker) enables launchesToVerify; a failed re-check of a settled launch waits retryMs. Without it
// every launch is verified on every run (one-shot scripts and tests).
// expiredLaunch(row) (worker: createExpiredLaunchCheck, src/launch-expiry.mjs) → the two-provider proof that a submitted or
// ambiguous attempt never landed and never can, or null. A proven attempt is released as 'failed' with a LAUNCH_EXPIRED
// operator alert, so its repository can launch again. Without it such an attempt waits for scripts/recover-expired-launch.mjs.
export function createLaunchIndexer({ pool, verify, expiredLaunch = null, reverifyAfterMs = null, maxReverify = 5, retryMs = 15 * 60_000, now = Date.now }) {
  const retryAt = new Map()
  const reconcileMarket = async market => {
    const result = await verify(market)
    if (result.state !== 'match') return result
    if (market.launchSlot !== null && market.launchSlot !== result.slot) {
      return { state: 'mismatch', reason: `Recorded slot ${market.launchSlot} differs from finalized slot ${result.slot}` }
    }
    if (market.launchFinality !== null && market.launchFinality !== result.finality) {
      return { state: 'mismatch', reason: 'Recorded finality contradicts chain evidence' }
    }
    if (usesActivationClock(market) && (!result.blockTime || (market.launchBlockTime &&
        market.launchBlockTime.getTime() !== result.blockTime.getTime()))) {
      return { state: 'mismatch', reason: 'Discovery or bonus launch timestamp is unavailable or contradicts chain evidence' }
    }
    return result
  }
  // Under the market lock: the attempt as the proof reads it, released when proven. The proof, or null (tried again next run).
  const releaseExpired = async (client, market) => {
    const { rows: [row] } = await client.query(`select ${EXPIRY_MARKET_COLUMNS} from markets where id = $1`, [market.id])
    const proven = row ? await expiredLaunch(row) : null
    if (!proven) return null
    try { await releaseExpiredLaunch(client, row, proven, 'worker') }
    catch (error) { console.warn('launch_release_failed', { marketId: market.id, error: String(error?.message ?? error).slice(0, 120) }); return null }
    return proven.proof
  }
  const withMarketLock = async (repoId, callback) => {
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try { return await callback(drizzle(client), client) }
      finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  const processMarket = async repoId => withMarketLock(repoId, async (db, client) => {
    const market = (await db.select().from(markets).where(eq(markets.githubRepoId, repoId)).limit(1))[0]
    if (!market) return { repoId: repoId.toString(), state: 'missing', reason: 'Database market disappeared' }
    if (!['confirmed', 'submitted', 'ambiguous'].includes(market.status)) {
      return { repoId: repoId.toString(), state: 'incomplete', reason: `Launch status is ${market.status}` }
    }
    const result = await reconcileMarket(market)
    if (result.state !== 'match') {
      // Its transaction is not found ('unavailable'): an attempt proven expired is released (expiredLaunch above).
      if (expiredLaunch && result.state === 'unavailable' && ['submitted', 'ambiguous'].includes(market.status)) {
        const proof = await releaseExpired(client, market)
        if (proof) return { repoId: repoId.toString(), state: 'released', reason: 'Launch transaction expired without landing',
          marketId: market.id, evidenceHash: proof.evidenceHash }
      }
      return { repoId: repoId.toString(), ...result }
    }
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
      const candidates = await db.select({ githubRepoId: markets.githubRepoId, status: markets.status, indexedAt: markets.indexedAt,
        launchFinality: markets.launchFinality, lastVerifiedAt: markets.lastVerifiedAt }).from(markets)
        .where(inArray(markets.status, ['confirmed', 'submitted', 'ambiguous']))
      const results = []
      if (reverifyAfterMs === null) {
        for (const candidate of candidates) results.push(await processMarket(candidate.githubRepoId))
        return results
      }
      const at = now()
      for (const candidate of launchesToVerify(candidates, { now: at, reverifyAfterMs, maxReverify, retryAt })) {
        const result = await processMarket(candidate.githubRepoId)
        const key = candidate.githubRepoId.toString()
        if (settledLaunch(candidate) && !['verified', 'indexed', 'recovered'].includes(result.state)) retryAt.set(key, at + retryMs)
        else retryAt.delete(key)
        results.push(result)
      }
      return results
    },
  }
}
