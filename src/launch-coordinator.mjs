import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { PublicKey } from '@solana/web3.js'
import { markets, repositories } from './db/schema.mjs'
import { resolvePublicRepository } from './github.mjs'
import { DefinitiveLaunchError } from './meteora-launch.mjs'
import { DISCOVERY_VERSION } from './discovery-rewards.mjs'
import { marketSource } from './market-identity.mjs'
import { SOL_QUOTE, quoteStamp } from './quote-assets.mjs'
import { validateTokenImage } from './token-image.mjs'

// Named explicitly, like DefinitiveLaunchError: the production build renames classes.
export class IncompleteLaunchError extends Error {
  constructor(message) { super(message); this.name = 'IncompleteLaunchError' }
}

export async function waitForLaunchEvidence(inspect, market, attempts = 120, retryMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { if (await inspect(market)) return true }
    catch { /* Finalized RPC evidence can lag the confirmed submission. */ }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, retryMs))
  }
  return false
}

// The builder allocation and verification bonus stamps a NEW reservation carries. A Hugging Face model market carries the
// builder allocation like a repository (its verified Hugging Face owner claims it after graduation, src/builder-allocation.mjs)
// but never the verification bonus, whatever the environment enables (backed by the markets_hf_no_bonus check, migration 0052).
export function rewardStamps(githubRepoId, { builderAllocationEnabled, verificationBonusLamports, quote = SOL_QUOTE }) {
  // A stock-paired market (docs/STOCK_QUOTES.md) carries none of the SOL-denominated rewards: its launcher earns the
  // launcher-side fee instead, and the builder allocation's claim path is SOL-only.
  if (quote.type !== 'SOL') return { builderAllocationVersion: null, verificationBonusLamports: null }
  const builderAllocationVersion = builderAllocationEnabled ? 1 : null
  if (marketSource(githubRepoId) !== 'github') return { builderAllocationVersion, verificationBonusLamports: null }
  return { builderAllocationVersion, verificationBonusLamports }
}

// pendingReview(market) → true while a persisted launch review (src/launch-sessions.mjs) still owns a 'prepared'
// market; a second prepare is then refused instead of replacing the mint the first wallet is reviewing.
// verificationBonusLamports (bigint, from VERIFICATION_BONUS_LAMPORTS) is stamped on each NEW reservation, like
// discovery_version; confirmed markets are returned unchanged, so nothing is ever enrolled retroactively.
// source: where a launch request's market comes from — { kind, resolve(input) → repo, persist(db, repo) under the market
// lock }. Omitted, it is a public GitHub repository by URL, exactly as before; Hugging Face model markets pass
// hfLaunchSource (src/hf-launch.mjs). Either way the resolved id must belong to that source.
// quote: SOL (default) or the resolved stock asset this launch pairs with; it is stamped on the reservation (quoteStamp), and the
// launcher must have been built for it.
export function createLaunchCoordinator({ pool, launcher, fetchImpl = fetch,
  evidenceAttempts = 120, evidenceRetryMs = 250, discoveryEnabled = false, builderAllocationEnabled = false, pendingReview = null,
  verificationBonusLamports = null, source = null, quote = SOL_QUOTE }) {
  if (verificationBonusLamports !== null && (typeof verificationBonusLamports !== 'bigint' || verificationBonusLamports <= 0n)) {
    throw new Error('Verification bonus stamp must be positive bigint lamports')
  }
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
  const kind = source?.kind ?? 'github'
  const persist = source?.persist ?? saveRepo
  const resolve = async input => {
    const repo = await (source ? source.resolve(input) : resolvePublicRepository(input, fetchImpl))
    if (marketSource(repo.githubRepoId) !== kind) throw new Error(`Resolved market is not a ${kind} market`)
    return repo
  }
  const markFailed = (db, market) => db.update(markets).set({ status: 'failed' }).where(eq(markets.id, market.id))

  async function checkRequest({ repositoryUrl, tokenName, tokenSymbol, tokenImage, launcherWallet, signTransaction, requireSigner }) {
    if (!tokenName || tokenName.length > 32 || !tokenSymbol || tokenSymbol.length > 10) {
      throw new Error('Token name (1–32) and symbol (1–10) are required')
    }
    const image = tokenImage === null ? null : await validateTokenImage(tokenImage)
    if (requireSigner && typeof signTransaction !== 'function') throw new Error('Launcher signTransaction callback required')
    const wallet = new PublicKey(launcherWallet).toBase58()
    if (wallet === launcher.creatorWallet) throw new Error('Launcher wallet cannot be the platform creator authority')
    const repo = await resolve(repositoryUrl)
    return { image, wallet, repo }
  }

  // Under the repository lock: { existing } for a launched (or recovered) market, otherwise the freshly reserved row.
  async function reserve(db, repo, { wallet, tokenName, tokenSymbol, image }) {
    await persist(db, repo)
    let market = await findMarket(db, repo.githubRepoId)
    if (market?.status === 'confirmed') return { existing: market }
    if (market && ['submitted', 'ambiguous'].includes(market.status)) {
      if (market.launchSignature && await launcher.inspect(market)) {
        ;[market] = await db.update(markets).set({ status: 'confirmed' }).where(eq(markets.id, market.id)).returning()
        return { existing: market }
      }
      // The worker releases an attempt proven never to land (src/launch-expiry.mjs) about two minutes after its review.
      throw new IncompleteLaunchError(`This repository has an incomplete launch (${market.status}) that is still being checked on Solana. If its transaction did not land, you can launch again in about two minutes.`)
    }
    if (market?.status === 'prepared' && pendingReview && await pendingReview(market)) {
      throw new Error('This repository already has a launch awaiting wallet approval. Try again in a couple of minutes.')
    }
    const values = {
      githubRepoId: repo.githubRepoId, status: 'reserved', mint: null, pool: null,
      launcherWallet: wallet, creatorWallet: launcher.creatorWallet,
      tokenName, tokenSymbol, tokenImage: image, launchSignature: null,
      blockhash: null, lastValidBlockHeight: null,
      discoveryVersion: discoveryEnabled && quote.type === 'SOL' ? DISCOVERY_VERSION : null, launchBlockTime: null,
      ...rewardStamps(repo.githubRepoId, { builderAllocationEnabled, verificationBonusLamports, quote }),
      ...quoteStamp(quote),
    }
    if (market) {
      ;[market] = await db.update(markets).set(values).where(eq(markets.id, market.id)).returning()
    } else {
      ;[market] = await db.insert(markets).values(values).returning()
    }
    return { market }
  }

  // Under the repository lock: reserved → prepared. Any failure releases the reservation as 'failed'.
  async function prepareReserved(db, market, { repo, wallet, tokenName, tokenSymbol, initialBuyLamports, launchGuard }) {
    try {
      const prepared = await launcher.prepare({ launcherWallet: wallet, tokenName, tokenSymbol, initialBuyLamports })
      ;[market] = await db.update(markets).set({
        status: 'prepared', mint: prepared.mint, pool: prepared.pool,
        blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight,
      }).where(eq(markets.id, market.id)).returning()
      if (launchGuard) await launchGuard({ repo, market, stage: 'prepare' })
      return { market, prepared }
    } catch (error) {
      await markFailed(db, market)
      throw error
    }
  }

  // Under the repository lock with the market 'prepared': wallet signature → co-sign → submit → chain evidence.
  async function finish(db, market, prepared, { repo, signTransaction, launchGuard }) {
    try {
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
      if (market.status === 'prepared') await markFailed(db, market)
      throw error
    }
  }

  return {
    resolveRepository: (url) => resolve(url),
    async checkExistingLaunch(url) {
      const repo = await resolve(url)
      return withRepoLock(repo.githubRepoId, async db => {
        await persist(db, repo)
        const market = await findMarket(db, repo.githubRepoId)
        return market?.status === 'confirmed' ? market : null
      })
    },
    // One call in one process: the repository lock is held from reservation through the wallet signature to the result.
    async launch({ repositoryUrl, tokenName, tokenSymbol, tokenImage = null, launcherWallet, initialBuyLamports = '0', signTransaction, launchGuard }) {
      const { image, wallet, repo } = await checkRequest({ repositoryUrl, tokenName, tokenSymbol, tokenImage, launcherWallet, signTransaction, requireSigner: true })
      return withRepoLock(repo.githubRepoId, async db => {
        const reserved = await reserve(db, repo, { wallet, tokenName, tokenSymbol, image })
        if (reserved.existing) return reserved.existing
        const { market, prepared } = await prepareReserved(db, reserved.market, { repo, wallet, tokenName, tokenSymbol, initialBuyLamports, launchGuard })
        return finish(db, market, prepared, { repo, signTransaction, launchGuard })
      })
    },
    // Two requests, possibly on different replicas. prepareLaunch reserves and prepares under the repository lock and
    // runs onPrepared (which persists the review) before releasing it; { market } alone means nothing needs signing.
    async prepareLaunch({ repositoryUrl, tokenName, tokenSymbol, tokenImage = null, launcherWallet, initialBuyLamports = '0', launchGuard, onPrepared }) {
      const { image, wallet, repo } = await checkRequest({ repositoryUrl, tokenName, tokenSymbol, tokenImage, launcherWallet, requireSigner: false })
      return withRepoLock(repo.githubRepoId, async db => {
        const reserved = await reserve(db, repo, { wallet, tokenName, tokenSymbol, image })
        if (reserved.existing) return { market: reserved.existing, repo }
        const { market, prepared } = await prepareReserved(db, reserved.market, { repo, wallet, tokenName, tokenSymbol, initialBuyLamports, launchGuard })
        try { if (onPrepared) await onPrepared({ market, prepared, repo }) }
        catch (error) { await markFailed(db, market); throw error }
        return { market, prepared, repo }
      })
    },
    // `prepared` is restored from the persisted review (launcher.restore). The market must still be the one reviewed.
    async submitPrepared({ marketId, githubRepoId, mint, repo, prepared, signTransaction, launchGuard }) {
      if (typeof signTransaction !== 'function') throw new Error('Launcher signTransaction callback required')
      return withRepoLock(BigInt(githubRepoId), async db => {
        const market = (await db.select().from(markets).where(eq(markets.id, marketId)).limit(1))[0]
        if (!market || market.status !== 'prepared' || market.mint !== mint || market.githubRepoId !== BigInt(githubRepoId)) {
          throw new Error('Prepared launch expired; reload before trying again')
        }
        return finish(db, market, prepared, { repo, signTransaction, launchGuard })
      })
    },
  }
}
