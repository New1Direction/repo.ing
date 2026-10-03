import { chain } from '../../../lib/server.mjs'
import { NO_STORE, publicCacheHeaders } from '../../../lib/cache-headers.mjs'
import { quoteAssetInfo } from '../../../../src/quote-asset-info.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QUOTE_ASSET_CACHE = publicCacheHeaders(30)

// A stock pair's display facts for the trade panel (src/quote-asset-info.mjs): symbol, decimals, the multiplier wallets show
// its amounts with, and its USD price. Registry stock assets only; SOL and unknown ids are not found.
export async function GET(_request, { params }) {
  const { assetId } = await params
  try {
    const info = /^[a-z0-9][a-z0-9-]{1,31}$/.test(assetId ?? '') ? await quoteAssetInfo(assetId, { connection: chain() }) : null
    if (!info) return Response.json({ error: 'Pair not found' }, { status: 404, headers: NO_STORE })
    return Response.json(info, { headers: QUOTE_ASSET_CACHE })
  } catch {
    return Response.json({ error: 'Pair details are temporarily unavailable' }, { status: 503, headers: NO_STORE })
  }
}
