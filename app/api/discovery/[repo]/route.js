import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createDiscoveryClaims, DiscoveryClaimError } from '../../../../src/discovery-claims.mjs'
import { discoverySummary } from '../../../../src/discovery-rewards.mjs'
import { chain, configAddress, database, partnerSigner } from '../../../lib/server.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { createMarketConfigResolver } from '../../../../src/market-config.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
function service() {
  const pool = database(), config = configAddress()
  if (!pool || !config) throw new DiscoveryClaimError('Discovery rewards are temporarily unavailable')
  return { pool, config, connection: chain() }
}
const problem = error => json({ error: error instanceof DiscoveryClaimError ? error.message :
  'Discovery rewards could not be checked. Please retry; any submitted payout will continue to be checked.' }, 400)

export async function GET(_request, { params }) {
  try {
    const { repo } = await params
    if (!/^\d{1,18}$/.test(repo)) throw new DiscoveryClaimError('Valid repository ID required')
    const options = service()
    const summary = await discoverySummary(options.pool, repo)
    if (!summary) return json({ enrolled: false })
    const dbc = new DynamicBondingCurveClient(options.connection, 'finalized')
    let graduated = null
    try {
      const marketConfig = createMarketConfigResolver(options.config)(summary)
      const [state, fixed] = await Promise.all([dbc.state.getPool(summary.pool), dbc.state.getPoolConfig(marketConfig)])
      if (state && fixed) graduated = state.poolState.isMigrated !== 0 || state.poolState.quoteReserve.gte(fixed.migrationQuoteThreshold)
    } catch { /* Accrued ledger remains visible during a temporary RPC outage. */ }
    return json({ enrolled: true, version: summary.version, cap: summary.cap, wallet: summary.wallet, earned: summary.earned, paid: summary.paid,
      remaining: summary.remaining, expiresAt: summary.expiresAt, capped: summary.capped, expired: summary.expired,
      graduated, latestClaim: summary.latestClaim, payoutReady: Boolean(process.env.PLATFORM_PARTNER_SECRET_KEY) })
  } catch (error) { return problem(error) }
}

export async function POST(request, { params }) {
  try {
    if (request.headers.get('origin') !== publicOrigin(request.url)) throw new DiscoveryClaimError('Open this claim on repo.ing')
    const { repo } = await params
    if (!/^\d{1,18}$/.test(repo)) throw new DiscoveryClaimError('Valid repository ID required')
    if (Number(request.headers.get('content-length') || 0) > 8192) throw new DiscoveryClaimError('Claim request is too large')
    const body = await request.json()
    const claims = createDiscoveryClaims({ ...service(), partner: partnerSigner() })
    if (body.action === 'prepare') return json(await claims.prepare({ repoId: repo, wallet: body.wallet }))
    if (body.action === 'submit') return json(await claims.submit({ repoId: repo, id: body.id, transaction: body.transaction }))
    if (body.action === 'check') return json(await claims.recover(repo) ?? { status: 'idle' })
    throw new DiscoveryClaimError('Unsupported discovery claim action')
  } catch (error) { return problem(error) }
}
