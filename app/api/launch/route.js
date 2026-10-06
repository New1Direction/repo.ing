import { launchFailure } from '../../../src/launch-failure.mjs'
import { randomUUID } from 'node:crypto'
import { PublicKey, Transaction } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createLaunchCoordinator } from '../../../src/launch-coordinator.mjs'
import { createMeteoraLauncher, isVersionedLaunch, unsignedLaunchBase64 } from '../../../src/meteora-launch.mjs'
import { createEarlyAccessLauncher, readSignedVersionedLaunch } from '../../../src/early-access-launch.mjs'
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
import { persistLaunchRepository } from '../../../src/repository-store.mjs'
import { checkLaunchLineage } from '../../../src/repo-lineage.mjs'
import { verificationBonusLamports } from '../../../src/verification-bonus.mjs'
import { allocationEnabled } from '../../../src/builder-allocation.mjs'
import { HF_MARKETS_UNAVAILABLE, HF_OPT_OUT_ERROR, hfLaunchGuard, hfLaunchSource, hfMarketsEnabled, isHfMarketId,
  registeredModel } from '../../../src/hf-launch.mjs'
import { hfClient } from '../../lib/hf-client.mjs'
import { MODEL_LOOKUP_LIMITED, takeModelLookup } from '../../lib/hf-launch.mjs'
import { QUOTE_ERRORS, QuoteAssetError, SOL_QUOTE, resolveQuoteAsset, stockPairsLaunchable } from '../../../src/quote-assets.mjs'
import { composeGuards, launchPair, marketPairGuard, stockMintCheck, stockPairGuard } from '../../lib/stock-launch.mjs'
import { refuseOverLimit } from '../../lib/request-limits.mjs'
import { contributorSnapshotStep, earlyAccessGuard, earlyAccessRequest, earlyAccessSettings } from '../../lib/early-access-launch.mjs'
export const runtime = 'nodejs'
// Launch reviews live in PostgreSQL (launch_sessions) so prepare and submit/cancel may land on different replicas.
const launchSessions = (pool, creator) => createLaunchSessionStore({ pool, key: launchSessionKey(creator.secretKey) })
const sweep = store => store.expire().catch(error => console.warn('launch_session_sweep_failed', { code: error?.code ?? error?.name ?? 'error' }))
const safeError = (error, action) => {
  const result=launchFailure(error,action),supportCode=`LAUNCH-${result.code}-${randomUUID().slice(0,8)}`
  console.warn('launch_request_failed',{supportCode,action,code:result.code})
  return Response.json({...result,supportCode},{status:400,headers:{'Cache-Control':'no-store'}})
}

// Initial-buy quotes are SOL only: a stock-paired launch has no initial buy yet (src/meteora-launch.mjs). Any other pair is
// refused with its code before anything is read.
function assertSolBuyQuote(body) {
  const quote = resolveQuoteAsset(body.quoteAssetId, null, { enabled: false })
  if (quote !== SOL_QUOTE) throw new QuoteAssetError(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available.')
}
const stockPairsBuyRefusal = body => stockPairsLaunchable() && typeof body.quoteAssetId === 'string' && body.quoteAssetId !== 'sol' &&
  /^[a-z0-9][a-z0-9-]{1,31}$/.test(body.quoteAssetId)


// A Hugging Face model market (src/hf-launch.mjs): the repository review, keyed by the model's market id. The browser names
// the model by its registry _id (hfId); the server reads it through Hugging Face again at its registry path, and
// hfLaunchGuard checks it once more at prepare and after the wallet signs. No trend shortcut: trends are repositories only.
// On a config that reserves the builder allocation the model market carries it, for the model's verified owner to claim.
async function prepareModelLaunch(request, body) {
  if (!hfMarketsEnabled()) throw new Error(HF_MARKETS_UNAVAILABLE)
  // Contributor early access is for GitHub repositories: a model's request for it is refused with its own message.
  earlyAccessRequest(body)
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
      transaction = unsignedLaunchBase64(prepared.transaction)
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
      if (stockPairsBuyRefusal(body)) throw new QuoteAssetError(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock-paired launches have no initial buy yet. Buy after the launch.')
      assertSolBuyQuote(body)
      const config = configAddress()
      if (!config) throw new Error('Launch config is unavailable')
      const refused = refuseOverLimit(request, 'launch:quote')
      if (refused) return refused
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
    // A repository review is counted before GitHub or the chain is asked anything, the pair's own lookups included
    // (app/lib/request-limits.mjs). The form offers "Refresh review" on canRetry. A model review has its own lookup allowance.
    if (body.action === 'prepare' && !isHfMarketId(body.repoId)) {
      const refused = refuseOverLimit(request, 'launch:prepare', { canRetry: true })
      if (refused) return refused
    }
    // Contributor early access (docs/EARLY_ACCESS.md) is decided before anything is read or reserved: a GitHub repository paired
    // with SOL from its launch page, while early access can launch, on its own config and lookup table.
    const earlyAccess = body.action === 'prepare' ? earlyAccessRequest(body) : null
    // The pair is decided first (docs/STOCK_QUOTES.md): SOL as before; a stock pair only when it can launch, else refused.
    const pair = body.action === 'prepare' ? await launchPair(body, { solConfig: configAddress(), mintUsable: quote => stockMintCheck(chain())(quote) }) : null
    if (body.action === 'prepare' && isHfMarketId(body.repoId)) return await prepareModelLaunch(request, body)
    if (body.action === 'prepare') {
      const settings = earlyAccess ? earlyAccessSettings() : null
      if (earlyAccess && pair.quote !== SOL_QUOTE) throw new Error('Contributor early access launches are paired with SOL only.')
      if (body.agentDraft !== undefined) checkAgentDraft(body.agentDraft, body.repoId)
      const pool = database(), config = settings?.config ?? pair.config, creator = creatorSigner()
      if (!pool || !config || !creator) throw new Error('Local launch is not configured')
      if (!/^\d+$/.test(String(body.repoId))) throw new Error('Canonical repository ID required')
      if (!body.tokenImage) throw new Error('Choose a token image before reviewing the launch.')
      const resolved = await resolvePublicRepository(body.repositoryUrl)
      if (resolved.githubRepoId.toString() !== String(body.repoId)) throw new Error('Repository URL does not match canonical repository ID')
      await assertLaunchAllowed(pool, body.repoId)
      // The fork guard (src/repo-lineage.mjs): a fork or copy of a launched repository is refused here, on every launch path.
      await persistLaunchRepository(pool, resolved)
      await checkLaunchLineage({ pool, repo: resolved })
      const connection = chain()
      const metadataOrigin = process.env.APP_ORIGIN ? publicOrigin(request.url) : null
      if (process.env.NODE_ENV === 'production' && !metadataOrigin) throw new Error('Token metadata origin is not configured')
      const store = launchSessions(pool, creator)
      await sweep(store)
      const launcher = earlyAccess ? createEarlyAccessLauncher({ connection, config, creator, metadataOrigin, lookupTable: settings.lookupTable })
        : createMeteoraLauncher({ connection, config, creator, metadataOrigin, quote: pair.quote })
      const coordinator = createLaunchCoordinator({ pool, launcher, discoveryEnabled: discoveryRewardsEnabled(),
        // The early access config reserves the builder allocation when it is listed like any other config (src/builder-allocation.mjs).
        builderAllocationEnabled: earlyAccess ? allocationEnabled(config) : builderAllocationEnabled(),
        pendingReview: market => store.pending(market.id), verificationBonusLamports: verificationBonusLamports(), quote: pair.quote,
        earlyAccess: earlyAccess ? { windowSeconds: earlyAccess.windowSeconds, snapshot: contributorSnapshotStep({ pool }) } : null })
      if (body.trendRevision !== undefined && (!Number.isSafeInteger(body.trendRevision) || body.trendRevision < 1)) throw Error('Invalid trend approval')
      const launchGuard = earlyAccess ? earlyAccessGuard(config, { versioned: true })
        : pair.quote.type !== 'SOL' ? stockPairGuard(pair.quote, config, { mintUsable: stockMintCheck(connection) })
        : body.trendRevision === undefined ? undefined : trendLaunchGuard({ pool, repoId: String(body.repoId),
          revision: body.trendRevision, config, discoveryEnabled: discoveryRewardsEnabled() })
      const id = randomUUID(), initialBuyLamports = body.initialBuyLamports ?? '0'
      let costs, transaction
      // Runs under the repository lock: a failure here releases the market as 'failed' (nothing is stored or signed).
      const { prepared } = await coordinator.prepareLaunch({ repositoryUrl: body.repositoryUrl,
        tokenName: body.tokenName, tokenSymbol: body.tokenSymbol, tokenImage: body.tokenImage, launcherWallet: body.launcherWallet,
        initialBuyLamports, launchGuard, onPrepared: async ({ market, prepared, repo }) => {
          costs = await estimateLaunchCosts(connection, prepared.transaction, initialBuyLamports)
          transaction = unsignedLaunchBase64(prepared.transaction)
          await store.create({ id, market, repoFullName: repo.fullName, config, transaction, mintSecretKey: prepared.mintSecretKey,
            blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, initialBuyLamports,
            trendRevision: body.trendRevision ?? null })
        } })
      if (!prepared) throw new Error('No wallet signature requested')
      // An early access review also says when the window closes and how many contributors can buy now (linked wallets).
      return Response.json({ id, costs, transaction, ...prepared.earlyAccess ? { earlyAccess: { end: new Date(prepared.earlyAccess.end * 1000).toISOString(),
        contributors: prepared.earlyAccess.contributors, linkedWallets: prepared.earlyAccess.linkedWallets, launcherListed: prepared.earlyAccess.launcherListed } } : {} })
    }
    if (body.action === 'submit') {
      const pool = database(), creator = creatorSigner()
      if (!pool || !creator) throw new Error('Local launch is not configured')
      const store = launchSessions(pool, creator)
      // Single use on every replica: whoever consumes the review first submits it; it is never available again.
      const session = await store.consume(body.id)
      if (!session) throw new Error('Prepared launch expired; reload before trying again')
      const connection = chain(), config = session.config, repoId = BigInt(session.githubRepoId)
      // An early access review is a v0 transaction (docs/EARLY_ACCESS.md); every other review is the legacy launch, as before.
      const versioned = isVersionedLaunch(session.transaction)
      const launcher = versioned ? createEarlyAccessLauncher({ connection, config, creator }) : createMeteoraLauncher({ connection, config, creator })
      let prepared
      try { prepared = launcher.restore(session) }
      catch (error) { await store.release(session); throw error }
      const coordinator = createLaunchCoordinator({ pool, launcher, discoveryEnabled: discoveryRewardsEnabled(), builderAllocationEnabled: builderAllocationEnabled() })
      // A model market is checked again after the wallet signed, before anything is sent (src/hf-launch.mjs).
      // A GitHub launch is decided again by its stamp (a stock pair as at prepare; nothing more for SOL; early access while it can
      // launch on the same config), then by its trend approval.
      const launchGuard = isHfMarketId(session.githubRepoId) ? hfLaunchGuard({ pool, hf: hfClient() })
        : composeGuards(marketPairGuard(config, { mintUsable: stockMintCheck(connection) }), earlyAccessGuard(config, { versioned }),
          session.trendRevision === null ? null
            : trendLaunchGuard({ pool, repoId: session.githubRepoId, revision: session.trendRevision, config, discoveryEnabled: discoveryRewardsEnabled() }))
      // Parsed inside the signing step so a malformed body fails the review (market 'failed') like a wallet mismatch.
      const market = await coordinator.submitPrepared({ marketId: session.marketId, githubRepoId: session.githubRepoId, mint: session.mint,
        repo: { githubRepoId: repoId, fullName: session.repoFullName }, prepared, launchGuard,
        signTransaction: async () => versioned ? readSignedVersionedLaunch(body.transaction) : Transaction.from(Buffer.from(body.transaction, 'base64')) })
      // An early access market's pool is on its own config, which the verifier resolves by the market's stamp.
      const verify = versioned ? createLaunchEvidenceVerifier({ connection, config: configAddress() ?? config, earlyAccessConfig: config })
        : createLaunchEvidenceVerifier({ connection, config })
      let result
      for (let attempt = 0; attempt < 120; attempt++) {
        result = await verify(market)
        if (result.state === 'match') break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (result?.state !== 'match') throw new Error('Launch confirmed but final indexing is not ready')
      const indexed = await createLaunchIndexer({ pool, verify }).processMarket(repoId)
      if (!['indexed', 'verified'].includes(indexed.state)) throw new Error('Canonical market did not index')
      // An early access launch's first buy (a hook pool, v0 transaction) is indexed like any other (docs/EARLY_ACCESS.md step 5).
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
