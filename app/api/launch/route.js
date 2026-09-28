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
export const runtime = 'nodejs'
const sessions = globalThis.__gitfunLaunchSessions ??= new Map()
const safeError = (error, action) => {
  const result=launchFailure(error,action),supportCode=`LAUNCH-${result.code}-${randomUUID().slice(0,8)}`
  console.warn('launch_request_failed',{supportCode,action,code:result.code})
  return Response.json({...result,supportCode},{status:400,headers:{'Cache-Control':'no-store'}})
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
      const session = sessions.get(body.id)
      if (session) {
        sessions.delete(body.id); clearTimeout(session.timeout)
        session.rejectSigned(new Error('Launch review cancelled before signing'))
        await session.job.catch(() => {})
      }
      return Response.json({ cancelled: true })
    }
    if (body.action === 'prepare') {
      if (body.agentDraft !== undefined) checkAgentDraft(body.agentDraft, body.repoId)
      const pool = database(), config = configAddress(), creator = creatorSigner()
      if (!pool || !config || !creator) throw new Error('Local launch is not configured')
      if (!/^\d+$/.test(String(body.repoId))) throw new Error('Canonical repository ID required')
      if (!body.tokenImage) throw new Error('Choose a token image before reviewing the launch.')
      const resolved = await resolvePublicRepository(body.repositoryUrl)
      if (resolved.githubRepoId.toString() !== String(body.repoId)) throw new Error('Repository URL does not match canonical repository ID')
      const connection = chain()
      const metadataOrigin = process.env.APP_ORIGIN ? publicOrigin(request.url) : null
      if (process.env.NODE_ENV === 'production' && !metadataOrigin) throw new Error('Token metadata origin is not configured')
      const launcher = createMeteoraLauncher({ connection, config, creator, metadataOrigin })
      const coordinator = createLaunchCoordinator({ pool, launcher, discoveryEnabled: discoveryRewardsEnabled(), builderAllocationEnabled: builderAllocationEnabled() })
      if (body.trendRevision !== undefined && (!Number.isSafeInteger(body.trendRevision) || body.trendRevision < 1)) throw Error('Invalid trend approval')
      const launchGuard = body.trendRevision === undefined ? undefined : trendLaunchGuard({ pool, repoId: String(body.repoId),
        revision: body.trendRevision, config, discoveryEnabled: discoveryRewardsEnabled() })
      let offerUnsigned, resolveSigned, rejectSigned
      const unsigned = new Promise(resolve => { offerUnsigned = resolve })
      const signed = new Promise((resolve, reject) => { resolveSigned = resolve; rejectSigned = reject })
      const job = coordinator.launch({ repositoryUrl: body.repositoryUrl, tokenName: body.tokenName,
        tokenSymbol: body.tokenSymbol, tokenImage: body.tokenImage, launcherWallet: body.launcherWallet,
        initialBuyLamports: body.initialBuyLamports ?? '0', launchGuard,
        signTransaction: async transaction => { offerUnsigned(transaction); return signed } })
      job.catch(() => {})
      const transaction = await Promise.race([unsigned, job.then(() => { throw new Error('No wallet signature requested') })])
      let costs
      try { costs = await estimateLaunchCosts(connection, transaction, body.initialBuyLamports ?? '0') }
      catch (error) { rejectSigned(error); await job.catch(() => {}); throw error }
      const id = randomUUID()
      const timeout = setTimeout(() => { rejectSigned(new Error('Wallet signing timed out')); sessions.delete(id) }, 120000)
      sessions.set(id, { job, resolveSigned, rejectSigned, timeout, pool, connection, config, repoId: body.repoId,
        initialBuyLamports: body.initialBuyLamports ?? '0' })
      return Response.json({ id, costs, transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') })
    }
    if (body.action === 'submit') {
      const session = sessions.get(body.id)
      if (!session) throw new Error('Prepared launch expired; reload before trying again')
      sessions.delete(body.id); clearTimeout(session.timeout)
      session.resolveSigned(Transaction.from(Buffer.from(body.transaction, 'base64')))
      const market = await session.job
      const verify = createLaunchEvidenceVerifier({ connection: session.connection, config: session.config })
      let result
      for (let attempt = 0; attempt < 120; attempt++) {
        result = await verify(market)
        if (result.state === 'match') break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (result?.state !== 'match') throw new Error('Launch confirmed but final indexing is not ready')
      const indexed = await createLaunchIndexer({ pool: session.pool, verify }).processMarket(BigInt(session.repoId))
      if (!['indexed', 'verified'].includes(indexed.state)) throw new Error('Canonical market did not index')
      if (BigInt(session.initialBuyLamports) > 0n) {
        try {
          await createFeeAccrual({ pool: session.pool, connection: session.connection, config: session.config })
            .recordTradeFees({ githubRepoId: BigInt(session.repoId), signatures: [market.launchSignature] })
          await createTradeRecorder({ pool: session.pool, connection: session.connection, config: session.config })(market, market.launchSignature)
        } catch (error) {
          console.error('Launch first-buy indexing will retry in the worker:', error.message)
        }
      }
      return Response.json({ mint: market.mint, pool: market.pool, signature: market.launchSignature })
    }
    throw new Error('Unsupported launch action')
  } catch (error) { return safeError(error, action) }
}
