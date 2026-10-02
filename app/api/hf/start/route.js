import { NextResponse } from 'next/server'
import { isMarketId, marketSource } from '../../../../src/market-identity.mjs'
import { hfMarketsEnabled } from '../../../../src/hf-verification.mjs'
import { isHfModelPath } from '../../../../src/hf-url.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { database, marketByRepo } from '../../../lib/server.mjs'
import { hfCookieOptions, hfStateCookie, sealHfState } from '../../../lib/hf-auth.mjs'
import { hfOAuth, hfVerifier } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// "Sign in with Hugging Face": OIDC with PKCE (S256). mode 'claim' signs in for one model market's claim page (?market=);
// mode 'models' for the /opt-out model section (?model=owner/name optionally names the model being managed). When the
// model belongs to an organization, its _id is passed as orgIds so Hugging Face asks the user to share that organization:
// only then does userinfo report the user's role in it. That owner lookup uses the shared anonymous Hugging Face budget,
// so past ORG_HINTS_PER_MINUTE sign-in starts without the hint (the user can still share the organization by hand).
const ORG_HINTS_PER_MINUTE = 60

function redirect(url) {
  const response = NextResponse.redirect(url)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

async function ownerOrgId(request, lookup) {
  try {
    if (!await takeQuota(database(), [['hf-start:org-hints', ORG_HINTS_PER_MINUTE, 60]])) return null
    const model = await lookup(hfVerifier(request.url))
    return model.owner.kind === 'org' ? model.owner.id : null
  } catch { return null /* Moved, private or busy: the page explains what to do after sign-in. */ }
}

export async function GET(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const origin = publicOrigin(request.url)
  const params = request.nextUrl.searchParams
  const mode = params.get('mode') === 'models' ? 'models' : 'claim'
  const marketId = mode === 'claim' ? params.get('market') ?? '' : null
  const modelPath = mode === 'models' && isHfModelPath(params.get('model') ?? '') ? params.get('model') : null
  const page = mode === 'claim' ? `/claim/${marketId}` : `/opt-out${modelPath ? `?model=${encodeURIComponent(modelPath)}` : ''}`
  const failed = code => {
    const url = new URL(page, origin)
    url.searchParams.set('error', code)
    if (mode === 'models') url.hash = 'models'
    return redirect(url)
  }

  if (mode === 'claim') {
    if (!/^\d{16}$/.test(marketId) || !isMarketId(marketId) || marketSource(marketId) !== 'huggingface') return redirect(new URL('/explore', origin))
    const { market } = await marketByRepo(marketId)
    if (!market || market.source !== 'huggingface') return redirect(new URL('/explore', origin))
  }
  let oauth
  try { oauth = hfOAuth(request.url) } catch { return failed('hf-unavailable') }
  if (!database()) return failed('hf-unavailable')
  const orgId = mode === 'claim' ? await ownerOrgId(request, verifier => verifier.resolveMarketModel(marketId, { update: false }))
    : modelPath ? await ownerOrgId(request, verifier => verifier.lookupModel(modelPath)) : null
  const authorization = oauth.authorizationUrl({ orgId })
  const response = redirect(authorization.url)
  response.cookies.set(hfStateCookie, sealHfState({ state: authorization.state, codeVerifier: authorization.codeVerifier, mode, marketId, model: modelPath }),
    { ...hfCookieOptions(), maxAge: 600 })
  return response
}
