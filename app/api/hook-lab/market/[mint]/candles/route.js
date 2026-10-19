import { createCoinActivityHandlers } from '../../../../../lib/hooklab-coin-activity.mjs'
export const dynamic = 'force-dynamic'
const { candles } = createCoinActivityHandlers()
export async function GET(request, { params }) { return candles(request, { mint: (await params).mint }) }
