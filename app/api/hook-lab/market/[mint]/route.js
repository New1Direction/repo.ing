import { createMarketHandler } from '../../../../lib/hooklab-market.mjs'
export const dynamic = 'force-dynamic'
const handler = createMarketHandler()
export async function GET(request, { params }) { return handler(request, { mint: (await params).mint }) }
