import { estimateTradeCosts, preflightTrade } from '../../../../../src/trade-costs.mjs'
import { actionOptions, handleBuyGet, handleBuyPost, loadActionMarket } from '../../../../lib/solana-actions.mjs'
import { chain, database, tradeAvailable } from '../../../../lib/server.mjs'
import { tradeRouter } from '../../../../lib/trader.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const loadMarket = mint => loadActionMarket(database(), mint)
// Same canonical curve/graduated trader and the same balance + simulation preflight as the site's prepare step.
async function prepareBuy(request) {
  const prepared = await (await tradeRouter()(request.githubRepoId)).prepareBuy(request)
  const connection = chain()
  await preflightTrade(connection, prepared, await estimateTradeCosts(connection, prepared))
  return prepared
}

export async function GET(request, { params }) {
  return handleBuyGet((await params).mint, { loadMarket, tradingEnabled: tradeAvailable })
}
export async function POST(request, { params }) {
  return handleBuyPost(request, (await params).mint, { loadMarket, prepareBuy })
}
export function OPTIONS() { return actionOptions() }
