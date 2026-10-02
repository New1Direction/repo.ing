import { actionOptions, handleSellGet, handleSellPost, loadActionMarket } from '../../../../lib/solana-actions.mjs'
import { database, tradeAvailable } from '../../../../lib/server.mjs'
import { prepareActionTrade, walletTokenBalance } from '../../../../lib/action-trades.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const loadMarket = mint => loadActionMarket(database(), mint)

// Sell 25%, 50% or 100% of the signing wallet's balance; the market Blink links here too (see buyAction).
export async function GET(request, { params }) {
  return handleSellGet((await params).mint, { loadMarket, tradingEnabled: tradeAvailable, ref: new URL(request.url).searchParams.get('ref') })
}
export async function POST(request, { params }) {
  return handleSellPost(request, (await params).mint, { loadMarket, tokenBalance: walletTokenBalance,
    prepareSell: trade => prepareActionTrade('sell', trade) })
}
export function OPTIONS() { return actionOptions() }
