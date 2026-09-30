import { NextResponse } from 'next/server'
import { XLinkError, X_LIMITS, X_STATE_MS, startAuthorization } from '../../../../src/x-links.mjs'
import { assertSameOrigin, cookieOptions, seal } from '../../../lib/auth.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
import { X_STATE_COOKIE, xLinksConfig, xLinksService } from '../../../lib/x-links.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
const SAFE = error => error instanceof XLinkError || /^Open the claim page/.test(error?.message ?? '')

// Starts Connect X for the connected wallet: seals nonce + PKCE verifier + wallet in a short-lived cookie, returns X's URL.
export async function POST(request) {
  const config = xLinksConfig()
  if (!config) return Response.json({ error: 'Not found' }, { status: 404, headers })
  try {
    const origin = publicOrigin(request.url)
    assertSameOrigin(request, origin)
    await xLinksService().quota(`x-connect:${clientKey(request)}`, X_LIMITS.connect)
    const body = await request.json().catch(() => ({}))
    const { url, state } = startAuthorization({ config, origin, wallet: body?.wallet })
    const response = NextResponse.json({ url }, { headers })
    response.cookies.set(X_STATE_COOKIE, seal(state), { ...cookieOptions, maxAge: X_STATE_MS / 1000 })
    return response
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'Connect X is temporarily unavailable.', 'x connect') }, { status: error?.status ?? 400, headers })
  }
}
