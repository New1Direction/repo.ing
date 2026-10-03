import { publicCacheHeaders, NO_STORE } from '../../../../lib/cache-headers.mjs'
import { quoteOptionsForRepo } from '../../../../lib/quote-options.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QUOTE_OPTIONS_CACHE = publicCacheHeaders(60)

// The pairs this repository can be launched with: SOL, plus an approved tokenized stock when stock pairs are on and the
// repository's GitHub owner maps to that stock's company (src/quote-assets.mjs). A launch submits only the chosen assetId.
export async function GET(_request, { params }) {
  const { repoId } = await params
  try {
    const result = /^[1-9]\d{0,18}$/.test(repoId ?? '') ? await quoteOptionsForRepo(repoId) : null
    if (!result) return Response.json({ error: 'Repository not found' }, { status: 404, headers: NO_STORE })
    return Response.json(result, { headers: QUOTE_OPTIONS_CACHE })
  } catch {
    return Response.json({ error: 'Pair options are temporarily unavailable' }, { status: 503, headers: NO_STORE })
  }
}
