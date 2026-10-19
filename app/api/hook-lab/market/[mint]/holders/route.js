import { createCoinActivityHandlers } from '../../../../../lib/hooklab-coin-activity.mjs'
export const dynamic = 'force-dynamic'
const { holders } = createCoinActivityHandlers()
export async function GET(request, { params }) { return holders(request, { mint: (await params).mint }) }
