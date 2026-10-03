import { launchFailure } from '../../../src/launch-failure.mjs'
import { randomUUID } from 'node:crypto'
import { PublicKey, Transaction } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createLaunchCoordinator } from '../../../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../../../src/meteora-launch.mjs'
import { launchBuyPreset, launchBuyQuote } from '../../../src/launch-buy.mjs'
import { estimateLaunchCosts } from '../../../src/launch-costs.mjs'
import { createLaunchEvidenceVerifier } from '../../../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../../../src/launch-indexer.mjs'
import { createFeeAccrual } from '../../../src/fee-accrual.mjs'
import { createTradeRecorder } from '../../../src/trade-evidence.mjs'
import { resolvePublicRepository } from '../../../src/github.mjs'
import { trendLaunchGuard } from '../../../src/trend-intake.mjs'
import { database, chain, configAddress, creatorSigner, discoveryRewardsEnabled, builderAllocationEnabled } from '../../lib/server.mjs'
import { checkAgentDraft } from '../../lib/agent-launch.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { readLimitedBody } from '../../../src/token-image.mjs'
import { createLaunchSessionStore, launchSessionKey } from '../../../src/launch-sessions.mjs'
import { activeDecision, assertLaunchAllowed } from '../../../src/maintainer-opt-outs.mjs'
import { verificationBonusLamports } from '../../../src/verification-bonus.mjs'
import { HF_MARKETS_UNAVAILABLE, HF_OPT_OUT_ERROR, hfLaunchGuard, hfLaunchSource, hfMarketsEnabled, isHfMarketId,
  registeredModel } from '../../../src/hf-launch.mjs'
import { hfClient } from '../../lib/hf-client.mjs'
import { MODEL_LOOKUP_LIMITED, takeModelLookup } from '../../lib/hf-launch.mjs'
import { QUOTE_ERRORS, QuoteAssetError, SOL_QUOTE, resolveQuoteAsset, stockPairsLaunchable } from '../../../src/quote-assets.mjs'
export const runtime = 'nodejs'
// Launch reviews live in PostgreSQL (launch_sessions) so prepare and submit/cancel may land on different replicas.
const launchSessions = (pool, creator) => createLaunchSessionStore({ pool, key: launchSessionKey(creator.secretKey) })
const sweep = store => store.expire().catch(error => console.warn('launch_session_sweep_failed', { code: error?.code ?? error?.name ?? 'error' }))
const safeError = (error, action) => {
  const result=launchFailure(error,action),supportCode=`LAUNCH-${result.code}-${randomUUID().slice(0,8)}`
  console.warn('launch_request_failed',{supportCode,action,code:result.code})
  return Response.json({...result,supportCode},{status:400,headers:{'Cache-Control':'no-store'}})
}

// The pair a launch asks for (docs/STOCK_QUOTES.md). Only SOL launches are wired so far, so every other pair is refused here
// with its code, before anything is read or reserved; nothing ever falls back from a stock pair to SOL.
function assertSolLaunch(body) {
  const quote = resolveQuoteAsset(body.quoteAssetId, null, { enabled: stockPairsLaunchable() })
  if (quote !== SOL_QUOTE) throw new QuoteAssetError(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available yet.')
}

// A Hugging Face model market (src/hf-launch.mjs): the repository review, keyed by the model's market id. The browser names
// the model by its registry _id (hfId); the server reads it through Hugging Face again at its registry path, and
// hfLaunchGuard checks it once more at prepare and after the wallet signs. No trend shortcut: trends are repositories only.
// On a config that reserves the builder allocation the model market carries it, for the model's verified owner to claim.
async function prepareModelLaunch(request, body) {
  if (!hfMarketsEnabled()) throw new Error(HF_MARKETS_UNAVAILABLE)
  if (body.agentDraft !== undefined) checkAgentDraft(body.agentDraft, body.repoId)
  const pool = database(), config = configAddress(), creator = creatorSigner()
  if (!pool || !config || !creator) throw new Error('Local launch is not configured')
  if (body.trendRevision !== undefined) throw new Error('Trend launches are for GitHub repositories only')
  if (!body.tokenImage) throw new Error('Choose a token image before reviewing the launch.')
  const marketRef = String(body.repoId), registered = await registeredModel(pool, marketRef)
  if (!registered || registered.hfId !== body.hfId) throw new Error('This model changed. Paste its Hugging Face URL and review the launch again.')
  if (await activeDecision(pool, marketRef)) throw new Error(HF_OPT_OUT_ERROR)
  if (!await takeModelLookup(pool, request)) throw new Error(MODEL_LOOKUP_LIMITED)
  const connection = chain()
  const metadataOrigin = process.env.APP_ORIGIN ? publicOrigin(request.url) : null
  if (process.env.NODE_ENV === 'production' && !metadataOrigin) throw new Error('Token metadata origin is not configured')
  const store = launchSessions(pool, creator)
  await sweep(store)
  const hf = hfClient(), launcher = createMeteoraLauncher({ connection, config, creator, metadataOrigin })
  // The shared reward settings go in unchanged: rewardStamps() stamps a model market's allocation but never the bonus.
  const coordinator = createLaunchCoordinator({ pool, launcher, discoveryEnabled: discoveryRewardsEnabled(), builderAllocationEnabled: builderAllocationEnabled(),
    pendingReview: market => store.pending(market.id), verificationBonusLamports: verificationBonusLamports(),
    source: hfLaunchSource({ pool, hf, expected: { hfId: registered.hfId, marketRef } }) })
  const id = randomUUID(), initialBuyLamports = body.initialBuyLamports ?? '0'
  let costs, transaction
  const { prepared } = await coordinator.prepareLaunch({ repositoryUrl: registered.repoPath,
    tokenName: body.tokenName, tokenSymbol: body.tokenSymbol, tokenImage: body.tokenImage, launcherWallet: body.launcherWallet,
    initialBuyLamports, launchGuard: hfLaunchGuard({ pool, hf }), onPrepared: async ({ market, prepared, repo }) => {
      costs = await estimateLaunchCosts(connection, prepared.transaction, initialBuyLamports)
      transaction = prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
      await store.create({ id, market, repoFullName: repo.fullName, config, transaction, mintSecretKey: prepared.mintSecretKey,
        blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, initialBuyLamports })
    } })
  if (!prepared) throw new Error('No wallet signature requested')
  return Response.json({ id, costs, transaction })
}

export async function GET(request) {
  const repoId=new URL(request.url).searchParams.get('repo')
  if(!/^[1-9]\d{0,18}$/.test(repoId??''))return Response.json({error:'Invalid repository'},{status:400})
  try{
    const row=(await database().query('select status,mint,indexed_at,launch_finality from markets where github_repo_id=$1',[repoId])).rows[0]
    const live=row?.status==='confirmed'&&row.indexed_at&&row.launch_finality==='finalized'
    return Response.json({state:live?'live':!row||row.status==='failed'?'retry':'pending',mint:live?row.mint:null},{headers:{'Cache-Control':'no-store'}})
  }catch{return Response.json({error:'Launch status unavailable. Please check again shortly.'},{status:503})}
}

export async function POST(request) {
  let action
  try {
    const body = JSON.parse((await readLimitedBody(request, 600_000)).toString('utf8'))
    action = ['quote','cancel','prepare','submit'].includes(body.action) ? body.action : 'unknown'
    if (body.action === 'quote') {
      assertSolLaunch(body)
      const config = configAddress()
      if (!config) throw new Error('Launch config is unavailable')
      const dbc = new DynamicBondingCurveClient(chain(), 'confirmed')
      const fixed = await dbc.state.getPoolConfig(new PublicKey(config))
      if (!fixed) throw new Error('Launch config is unavailable')
      const initialBuyLamports = body.supplyBps === undefined ? body.initialBuyLamports : launchBuyPreset(dbc, fixed, body.supplyBps)
      const quote = launchBuyQuote(dbc, fixed, initialBuyLamports)
      const output = BigInt(quote?.outputAmount.toString() ?? '0')
      return Response.json({ initialBuyLamports, tokenBaseUnits: output.toString(),
        supplyBps: Number(output) / 1_000_000_000_000_000 * 10_000,
        tradingFeeLamports: quote?.tradingFee.toString() ?? '0' })
    }
    if (body.action === 'cancel') {
      const pool = database(), creator = creatorSigner()
      // Best effort, as before: an uncancelled review still expires (and releases its market) after two minutes.
      if (pool && creator) {
        const store = launchSessions(pool, creator)
        await store.cancel(body.id).catch(error => console.warn('launch_session_cancel_failed', { code: error?.code ?? error?.name ?? 'error' }))
        await sweep(store)
      }
      return Response.json({ cancelled: true })
    }
    if (body.action === 'prepare') assertSolLaunch(body)
    if (body.action === 'prepare' && isHfMarketId(body.repoId)) return await prepareModelLaunch(request, body)
    if (body.action === 'prepare') {
      if (body.agentDraft !== undefined) checkAgentDraft(body.agentDraft, body.repoId)
      const pool = database(), config = configAddress(), creator = creatorSigner()
      if (!pool || !config || !creator) throw new Error('Local launch is not configured')
      if (!/^\d+$/.test(String(body.repoId))) throw new Error('Canonical repository ID required')
      if (!body.tokenImage) throw new Error('Choose a token image before reviewing the launch.')
      const resolved = await resolvePublicRepository(body.repositoryUrl)
      if (resolved.githubRepoId.toString() !== String(body.repoId)) throw new Error('Repository URL does not match canonical repository ID')
      await assertLaunchAllowed(pool, body.repoId)
      const connection = chain()
      const metadataOrigin = process.env.APP_ORIGIN ? publicOrigin(request.url) : null
      if (process.env.NODE_ENV === 'production' && !metadataOrigin) throw new Error('Token metadata origin is not configured')
      const store = launchSessions(pool, creator)
      await sweep(store)
      const launcher = createMeteoraLauncher({ connection, config, creator, metadataOrigin })
      const coordinator = createLaunchCoordinator({ pool, launcher, discoveryEnabled: discoveryRewardsEnabled(), builderAllocationEnabled: builderAllocationEnabled(),
        pendingReview: market => store.pending(market.id), verificationBonusLamports: verificationBonusLamports() })
      if (body.trendRevision !== undefined && (!Number.isSafeInteger(body.trendRevision) || body.trendRevision < 1)) throw Error('Invalid trend approval')
      const launchGuard = body.trendRevision === undefined ? undefined : trendLaunchGuard({ pool, repoId: String(body.repoId),
        revision: body.trendRevision, config, discoveryEnabled: discoveryRewardsEnabled() })
      const id = randomUUID(), initialBuyLamports = body.initialBuyLamports ?? '0'
      let costs, transaction
      // Runs under the repository lock: a failure here releases the market as 'failed' (nothing is stored or signed).
      const { prepared } = await coordinator.prepareLaunch({ repositoryUrl: body.repositoryUrl,
        tokenName: body.tokenName, tokenSymbol: body.tokenSymbol, tokenImage: body.tokenImage, launcherWallet: body.launcherWallet,
        initialBuyLamports, launchGuard, onPrepared: async ({ market, prepared, repo }) => {
          costs = await estimateLaunchCosts(connection, prepared.transaction, initialBuyLamports)
          transaction = prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
          await store.create({ id, market, repoFullName: repo.fullName, config, transaction, mintSecretKey: prepared.mintSecretKey,
            blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, initialBuyLamports,
            trendRevision: body.trendRevision ?? null })
        } })
      if (!prepared) throw new Error('No wallet signature requested')
      return Response.json({ id, costs, transaction })
    }
    if (body.action === 'submit') {
      const pool = database(), creator = creatorSigner()
      if (!pool || !creator) throw new Error('Local launch is not configured')
      const store = launchSessions(pool, creator)
      // Single use on every replica: whoever consumes the review first submits it; it is never available again.
      const session = await store.consume(body.id)
      if (!session) throw new Error('Prepared launch expired; reload before trying again')
      const connection = chain(), config = session.config, repoId = BigInt(session.githubRepoId)
      const launcher = createMeteoraLauncher({ connection, config, creator })
      let prepared
      try { prepared = launcher.restore(session) }
      catch (error) { await store.release(session); throw error }
      const coordinator = createLaunchCoordinator({ pool, launcher, discoveryEnabled: discoveryRewardsEnabled(), builderAllocationEnabled: builderAllocationEnabled() })
      // A model market is checked again after the wallet signed, before anything is sent (src/hf-launch.mjs).
      const launchGuard = isHfMarketId(session.githubRepoId) ? hfLaunchGuard({ pool, hf: hfClient() })
        : session.trendRevision === null ? undefined : trendLaunchGuard({ pool, repoId: session.githubRepoId,
          revision: session.trendRevision, config, discoveryEnabled: discoveryRewardsEnabled() })
      // Parsed inside the signing step so a malformed body fails the review (market 'failed') like a wallet mismatch.
      const market = await coordinator.submitPrepared({ marketId: session.marketId, githubRepoId: session.githubRepoId, mint: session.mint,
        repo: { githubRepoId: repoId, fullName: session.repoFullName }, prepared, launchGuard,
        signTransaction: async () => Transaction.from(Buffer.from(body.transaction, 'base64')) })
      const verify = createLaunchEvidenceVerifier({ connection, config })
      let result
      for (let attempt = 0; attempt < 120; attempt++) {
        result = await verify(market)
        if (result.state === 'match') break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (result?.state !== 'match') throw new Error('Launch confirmed but final indexing is not ready')
      const indexed = await createLaunchIndexer({ pool, verify }).processMarket(repoId)
      if (!['indexed', 'verified'].includes(indexed.state)) throw new Error('Canonical market did not index')
      if (BigInt(session.initialBuyLamports) > 0n) {
        try {
          await createFeeAccrual({ pool, connection, config })
            .recordTradeFees({ githubRepoId: repoId, signatures: [market.launchSignature] })
          await createTradeRecorder({ pool, connection, config })(market, market.launchSignature)
        } catch (error) {
          console.error('Launch first-buy indexing will retry in the worker:', error.message)
        }
      }
      // The launch kit offers "Invite the maintainer" unless an admin has verified this repository (best effort: unknown is not verified).
      const verified = await pool.query(`select exists(select 1 from repo_verifications where github_repo_id = $1 and permission = 'admin')
        or exists(select 1 from repo_beneficiaries where github_repo_id = $1) as verified`, [session.githubRepoId])
        .then(result => result.rows[0]?.verified === true, () => false)
      return Response.json({ mint: market.mint, pool: market.pool, signature: market.launchSignature, verified })
    }
    throw new Error('Unsupported launch action')
  } catch (error) { return safeError(error, action) }
}
