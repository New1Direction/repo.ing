import { isMarketId, marketSource } from '../../../../src/market-identity.mjs'
import { hfMarketsEnabled } from '../../../../src/hf-verification.mjs'
import { isHfModelPath } from '../../../../src/hf-url.mjs'
import { database, marketByRepo } from '../../../lib/server.mjs'
import { hfRedirect, hfStateCookie, sealHfState } from '../../../lib/hf-auth.mjs'
import { hfOAuth } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// "Sign in with Hugging Face": OIDC with PKCE (S256). mode 'claim' signs in for one model market's claim page (?market=);
// mode 'models' for the /opt-out model section (?model=owner/name optionally names the model being managed). When the
// model belongs to an organization, its _id is passed as orgIds so Hugging Face asks the user to share that organization:
// only then does userinfo report the user's role in it. The hint costs no Hugging Face call (this route is anonymous):
// a market's comes from its registry row (the owner last confirmed), the model section passes ?org= from its own lookup.
// A wrong or stale hint only changes what the consent screen offers; every authority check reads the owner fresh.
const ORG_ID = /^[0-9a-f]{24}$/

async function registryOrgHint(pool, marketId) {
  try {
    const { rows: [row] } = await pool.query('select owner_kind as kind, owner_subject as subject from hf_models where market_ref = $1', [marketId])
    return row?.kind === 'org' && ORG_ID.test(row.subject ?? '') ? row.subject : null
  } catch { return null }
}

export async function GET(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const origin = publicOrigin(request.url)
  const params = new URL(request.url).searchParams
  const mode = params.get('mode') === 'models' ? 'models' : 'claim'
  const marketId = mode === 'claim' ? params.get('market') ?? '' : null
  const modelPath = mode === 'models' && isHfModelPath(params.get('model') ?? '') ? params.get('model') : null
  const page = mode === 'claim' ? `/claim/${marketId}` : `/opt-out${modelPath ? `?model=${encodeURIComponent(modelPath)}` : ''}`
  const failed = code => {
    const url = new URL(page, origin)
    url.searchParams.set('error', code)
    if (mode === 'models') url.hash = 'models'
    return hfRedirect(url)
  }

  if (mode === 'claim') {
    if (!/^\d{16}$/.test(marketId) || !isMarketId(marketId) || marketSource(marketId) !== 'huggingface') return hfRedirect(new URL('/explore', origin))
    const { market } = await marketByRepo(marketId)
    if (!market || market.source !== 'huggingface') return hfRedirect(new URL('/explore', origin))
  }
  const pool = database()
  let oauth
  try { oauth = hfOAuth(request.url) } catch { return failed('hf-unavailable') }
  if (!pool) return failed('hf-unavailable')
  const orgId = mode === 'claim' ? await registryOrgHint(pool, marketId) : ORG_ID.test(params.get('org') ?? '') ? params.get('org') : null
  const authorization = oauth.authorizationUrl({ orgId })
  return hfRedirect(authorization.url, { cookies: [[hfStateCookie,
    sealHfState({ state: authorization.state, codeVerifier: authorization.codeVerifier, mode, marketId, model: modelPath }), 600]] })
}
