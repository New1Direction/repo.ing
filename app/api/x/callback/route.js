import { NextResponse } from 'next/server'
import { XLinkError, X_LIMITS, X_PENDING_MS, checkCallback, fetchXProfile } from '../../../../src/x-links.mjs'
import { cookieOptions, seal, unseal } from '../../../lib/auth.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { X_PENDING_COOKIE, X_STATE_COOKIE, xLinksConfig, xLinksService } from '../../../lib/x-links.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const CODES = [[/cancelled/, 'cancelled'], [/expired/, 'expired'], [/Too many/, 'rate-limited'], [/could not be verified/, 'invalid']]

// X redirects here. Verify state (CSRF), read the profile once, then park it until the wallet signs on /wallet.
export async function GET(request) {
  const config = xLinksConfig()
  if (!config) return new Response('Not found', { status: 404 })
  const origin = publicOrigin(request.url), back = new URL('/wallet', origin)
  back.hash = 'x-account'
  let pending = null
  try {
    const service = xLinksService()
    await service.quota(`x-callback:${clientKey(request)}`, X_LIMITS.callback)
    const { code, verifier, wallet } = checkCallback(unseal(request.cookies.get(X_STATE_COOKIE)?.value), request.nextUrl.searchParams)
    const profile = await fetchXProfile({ config, code, verifier, redirectUri: config.redirectUri(origin) })
    pending = await service.stagePending({ wallet, profile })
    back.searchParams.set('x', 'pending')
  } catch (error) {
    if (!(error instanceof XLinkError)) console.error('x callback failed', { error: error?.message ?? String(error) })
    back.searchParams.set('x', CODES.find(([pattern]) => pattern.test(error?.message ?? ''))?.[1] ?? 'failed')
  }
  const response = NextResponse.redirect(back, 303)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.cookies.set(X_STATE_COOKIE, '', { ...cookieOptions, maxAge: 0 })
  if (pending) response.cookies.set(X_PENDING_COOKIE, seal({ purpose: 'x-pending', id: pending.id, expiresAt: pending.expiresAt }), { ...cookieOptions, maxAge: X_PENDING_MS / 1000 })
  return response
}
