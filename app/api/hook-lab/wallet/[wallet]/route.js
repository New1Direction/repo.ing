import { createWalletBalancesHandler } from '../../../../lib/hooklab-market.mjs'
export const dynamic = 'force-dynamic'
const handler = createWalletBalancesHandler()
export async function GET(request, { params }) { return handler(request, { wallet: (await params).wallet }) }
