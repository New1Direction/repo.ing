import { actionOptions, handleBuyGet, handleBuyPost, loadActionMarket } from '../../../../lib/solana-actions.mjs'
import { database, tradeAvailable } from '../../../../lib/server.mjs'
import { prepareActionTrade } from '../../../../lib/action-trades.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const loadMarket = mint => loadActionMarket(database(), mint)

// ?ref (a shared Blink link's referrer) is carried into every linked buy and sell.
export async function GET(request, { params }) {
  return handleBuyGet((await params).mint, { loadMarket, tradingEnabled: tradeAvailable, ref: new URL(request.url).searchParams.get('ref') })
}
export async function POST(request, { params }) {
  return handleBuyPost(request, (await params).mint, { loadMarket, prepareBuy: trade => prepareActionTrade('buy', trade) })
}
export function OPTIONS() { return actionOptions() }
