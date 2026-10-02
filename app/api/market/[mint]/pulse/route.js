import { database, marketByMint } from '../../../../lib/server.mjs'
import { readRepoPulse } from '../../../../lib/dev-pulse.mjs'
import { isPromotionExcluded } from '../../../../lib/promotion-exclusions.mjs'
import { maintainerDecision } from '../../../../lib/maintainer-opt-outs.mjs'
import { NO_STORE, PULSE_CACHE } from '../../../../lib/cache-headers.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// Public GitHub activity for one market's repository (Dev Pulse). Do-not-promote and maintainer-declined repositories (or
// one whose decision cannot be read) get no pulse.
export async function GET(request, { params }) {
  const { mint } = await params
  if (!MINT.test(mint)) return Response.json({ error: 'Invalid token mint' }, { status: 400, headers: NO_STORE })
  try {
    const { market, unavailable } = await marketByMint(mint)
    if (unavailable) return Response.json({ error: 'Market data unavailable' }, { status: 503, headers: NO_STORE })
    if (!market) return Response.json({ error: 'Market not found' }, { status: 404, headers: NO_STORE })
    if (isPromotionExcluded(market.repoId) || await maintainerDecision(market.repoId) !== null) return Response.json({ status: 'hidden' }, { headers: PULSE_CACHE })
    const pulse = await readRepoPulse(database(), market.repoId)
    return Response.json(pulse ?? { status: 'pending', checkedAt: null }, { headers: PULSE_CACHE })
  } catch (error) {
    console.error('dev-pulse failed', { mint, error: error.message })
    return Response.json({ error: 'Dev Pulse unavailable' }, { status: 503, headers: NO_STORE })
  }
}
