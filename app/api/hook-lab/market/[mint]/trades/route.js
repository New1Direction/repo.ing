import { createCoinActivityHandlers } from '../../../../../lib/hooklab-coin-activity.mjs'
export const dynamic = 'force-dynamic'
const { trades } = createCoinActivityHandlers()
export async function GET(request, { params }) { return trades(request, { mint: (await params).mint }) }
