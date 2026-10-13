import { chain, configAddress, marketByMint, database } from '../../../../../lib/server.mjs'
import { apiHeaders, apiJson, apiNoStore, apiOptions } from '../../../../../lib/public-api.mjs'
import { refuseOverLimit } from '../../../../../lib/request-limits.mjs'
import { withServerTiming } from '../../../../../lib/server-timing.mjs'
import { curveSnapshot, dammSnapshot, sampleSummary, snapshotProfile } from '../../../../../../src/market-liquidity.mjs'
import { createMarketConfigResolver } from '../../../../../../src/market-config.mjs'
import { isStockMarket } from '../../../../../../src/stock-market-chart.mjs'
import { tradingEarlyAccessConfig } from '../../../../../../src/early-access.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const CACHE_MS = 10_000
const cached = globalThis.__repoingLiveLiquidity ??= new Map()

// Live market-maker feed for one market (docs/MARKET_DATA_API.md#liquidity): spot, current fee, depth within 1/2/5% on each side and
// the quoted spread at 0.1 and 1 SOL, from one pool snapshot and the SDK's exact quotes. One snapshot per mint per 10 s per process.
async function liveProfile(market) {
  const hit = cached.get(market.mint)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const value = (async () => {
    const connection = chain()
    const { rows: [graduated] } = await database().query('select pool from graduation_events where github_repo_id = $1', [market.repoId])
    const snapshot = graduated
      ? await dammSnapshot({ connection, market, pool: graduated.pool })
      : await curveSnapshot({ connection, market, configKey: createMarketConfigResolver(configAddress(), undefined, undefined, { earlyAccess: tradingEarlyAccessConfig() })(market) })
    const profile = snapshotProfile(snapshot)
    return { ...profile, summary: sampleSummary(profile), checkedAt: new Date().toISOString() }
  })()
  if (cached.size >= 500) cached.delete(cached.keys().next().value)
  cached.set(market.mint, { value, expiresAt: Date.now() + CACHE_MS })
  value.catch(() => cached.delete(market.mint))
  return value
}

export const OPTIONS = apiOptions
export const GET = withServerTiming(async (request, { params }) => {
  const { mint } = await params
  if (!MINT.test(mint)) return apiJson({ error: 'Market not found' }, { status: 404, headers: apiNoStore })
  const { market } = await marketByMint(mint)
  if (!market || !configAddress() || !database()) return apiJson({ error: 'Market not found' }, { status: 404, headers: apiNoStore })
  if (isStockMarket(market)) return apiJson({ error: 'Live liquidity is published for SOL markets only' }, { status: 404, headers: apiNoStore })
  const refused = refuseOverLimit(request, 'market-data:liquidity')
  if (refused) return refused
  try {
    return apiJson({ market: { repoId: market.repoId, mint: market.mint, symbol: market.symbol }, liquidity: await liveProfile(market),
      note: 'A snapshot from SDK quotes against current pool state; other trades change execution. Not an offer or advice.' }, { headers: apiHeaders(10, 20) })
  } catch {
    return apiJson({ error: 'Live liquidity is temporarily unavailable' }, { status: 503, headers: apiNoStore })
  }
})
