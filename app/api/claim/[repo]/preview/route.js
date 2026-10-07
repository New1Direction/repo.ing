import { feeStatus, marketByRepo } from '../../../../lib/server.mjs'
import { STOCK_PAIR_NO_OWNER_CLAIM, isStockPairMarket, noOwnerClaimMessage } from '../../../../../src/stock-owner-claims.mjs'
import { nextClaimAmount } from '../../../../../src/claim-amounts.mjs'
export const runtime = 'nodejs'
export async function GET(request, { params }) {
  const { repo } = await params
  if (!/^\d+$/.test(repo)) return Response.json({ error: 'Invalid repository' }, { status: 400 })
  const { market } = await marketByRepo(repo)
  if (!market) return Response.json({ error: 'Market not found' }, { status: 404 })
  // Stock pairs have no owner claim: nothing is ever available to an owner, and the SOL reconciler is never asked.
  if (isStockPairMarket(market)) return Response.json({ available: null, code: STOCK_PAIR_NO_OWNER_CLAIM, error: noOwnerClaimMessage(market) },
    { status: 409, headers: { 'Cache-Control': 'no-store' } })
  // What the next claim pays (an early access market's DAMM v2 fees follow its curve part in a second claim).
  const fees = await feeStatus(repo)
  return Response.json({ available: nextClaimAmount(fees)?.toString() ?? null },
    { headers: { 'Cache-Control': 'no-store' } })
}
