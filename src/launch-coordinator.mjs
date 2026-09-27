import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { PublicKey } from '@solana/web3.js'
import { markets, repositories } from './db/schema.mjs'
import { resolvePublicRepository } from './github.mjs'
import { DefinitiveLaunchError } from './meteora-launch.mjs'
import { DISCOVERY_VERSION } from './discovery-rewards.mjs'
import { validateTokenImage } from './token-image.mjs'

export class IncompleteLaunchError extends Error {}

export async function waitForLaunchEvidence(inspect, market, attempts = 120, retryMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { if (await inspect(market)) return true }
    catch { /* Finalized RPC evidence can lag the confirmed submission. */ }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, retryMs))
  }
  return false
}

export function createLaunchCoordinator({ pool, launcher, fetchImpl = fetch,
  evidenceAttempts = 120, evidenceRetryMs = 250, discoveryEnabled = false, builderAllocationEnabled = false }) {
  async function withRepoLock(id, callback) {
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [id.toString()])
      try { return await callback(drizzle(client)) }
      finally { await client.query('select pg_advisory_unlock($1::bigint)', [id.toString()]) }
    } finally { client.release() }
  }
  const findMarket = async (db, id) => (await db.select().from(markets).where(eq(markets.githubRepoId, id)).limit(1))[0]
  const saveRepo = async (db, repo) => {
    await db.insert(repositories).values(repo).onConflictDoUpdate({
      target: repositories.githubRepoId,
      set: { ...repo, syncedAt: new Date() },
    })
  }
  return {
    resolveRepository: (url) => resolvePublicRepository(url, fetchImpl),
    async checkExistingLaunch(url) {
      const repo = await resolvePublicRepository(url, fetchImpl)
      return withRepoLock(repo.githubRepoId, async db => {
        await saveRepo(db, repo)
        const market = await findMarket(db, repo.githubRepoId)
        return market?.status === 'confirmed' ? market : null
      })
    },
    async launch({ repositoryUrl, tokenName, tokenSymbol, tokenImage = null, launcherWallet, initialBuyLamports = '0', signTransaction, launchGuard }) {
      if (!tokenName || tokenName.length > 32 || !tokenSymbol || tokenSymbol.length > 10) {
        throw new Error('Token name (1–32) and symbol (1–10) are required')
      }
      const image = tokenImage === null ? null : await validateTokenImage(tokenImage)
      if (typeof signTransaction !== 'function') throw new Error('Launcher signTransaction callback required')
      const wallet = new PublicKey(launcherWallet).toBase58()
      if (wallet === launcher.creatorWallet) throw new Error('Launcher wallet cannot be the platform creator authority')
      const repo = await resolvePublicRepository(repositoryUrl, fetchImpl)
      return withRepoLock(repo.githubRepoId, async db => {
        await saveRepo(db, repo)
        let market = await findMarket(db, repo.githubRepoId)
        if (market?.status === 'confirmed') return market
        if (market && ['submitted', 'ambiguous'].includes(market.status)) {
          if (market.launchSignature && await launcher.inspect(market)) {
            ;[market] = await db.update(markets).set({ status: 'confirmed' }).where(eq(markets.id, market.id)).returning()
            return market
          }
          throw new IncompleteLaunchError(`Repository ${repo.githubRepoId} has an incomplete launch (${market.status}); inspect chain evidence before retrying`)
        }
        const values = {
          githubRepoId: repo.githubRepoId, status: 'reserved', mint: null, pool: null,
          launcherWallet: wallet, creatorWallet: launcher.creatorWallet,
          tokenName, tokenSymbol, tokenImage: image, launchSignature: null,
          blockhash: null, lastValidBlockHeight: null,
          discoveryVersion: discoveryEnabled ? DISCOVERY_VERSION : null, launchBlockTime: null,
          builderAllocationVersion: builderAllocationEnabled ? 1 : null,
        }
        if (market) {
          ;[market] = await db.update(markets).set(values).where(eq(markets.id, market.id)).returning()
        } else {
          ;[market] = await db.insert(markets).values(values).returning()
        }
        let prepared
        try {
          prepared = await launcher.prepare({ launcherWallet: wallet, tokenName, tokenSymbol, initialBuyLamports })
          ;[market] = await db.update(markets).set({
            status: 'prepared', mint: prepared.mint, pool: prepared.pool,
            blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight,
          }).where(eq(markets.id, market.id)).returning()
          if (launchGuard) await launchGuard({ repo, market, stage: 'prepare' })
          const signed = await prepared.sign(signTransaction)
          if (launchGuard) await launchGuard({ repo, market, stage: 'submit' })
          ;[market] = await db.update(markets).set({ status: 'submitted', launchSignature: signed.signature })
            .where(eq(markets.id, market.id)).returning()
          try {
            await launcher.submit({ ...signed, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight })
          } catch (error) {
            if (error instanceof DefinitiveLaunchError) {
              await db.update(markets).set({ status: 'failed' }).where(eq(markets.id, market.id))
            } else {
              await db.update(markets).set({ status: 'ambiguous' }).where(eq(markets.id, market.id))
            }
            throw error
          }
          if (!await waitForLaunchEvidence(launcher.inspect, market, evidenceAttempts, evidenceRetryMs)) {
            await db.update(markets).set({ status: 'ambiguous' }).where(eq(markets.id, market.id))
            throw new IncompleteLaunchError('Transaction submitted; pool evidence is still pending. Do not retry this launch.')
          }
          ;[market] = await db.update(markets).set({ status: 'confirmed' }).where(eq(markets.id, market.id)).returning()
          return market
        } catch (error) {
          if (!prepared || market.status === 'prepared') {
            await db.update(markets).set({ status: 'failed' }).where(eq(markets.id, market.id))
          }
          throw error
        }
      })
    },
  }
}
