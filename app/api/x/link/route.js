import { NextResponse } from 'next/server'
import { XLinkError, X_LIMITS, base58Wallet } from '../../../../src/x-links.mjs'
import { assertSameOrigin, cookieOptions, seal, unseal } from '../../../lib/auth.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
import { X_PENDING_COOKIE, forgetXHandle, xLinksEnabled, xLinksService } from '../../../lib/x-links.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
const SAFE = error => error instanceof XLinkError || /^Open the claim page/.test(error?.message ?? '')
const notFound = () => Response.json({ error: 'Not found' }, { status: 404, headers })
const fail = error => Response.json({ error: publicError(error, SAFE, 'X linking is temporarily unavailable.', 'x link') }, { status: error?.status ?? 400, headers })
const pendingId = request => {
  const sealed = unseal(request.cookies.get(X_PENDING_COOKIE)?.value)
  return sealed?.purpose === 'x-pending' ? sealed.id : null
}
const clearPending = response => { response.cookies.set(X_PENDING_COOKIE, '', { ...cookieOptions, maxAge: 0 }); return response }

// ?wallet=… → that wallet's public link, plus this browser's X sign-in waiting for a signature (if any).
export async function GET(request) {
  if (!xLinksEnabled()) return notFound()
  try {
    const service = xLinksService(), wallet = base58Wallet(new URL(request.url).searchParams.get('wallet'))
    const id = pendingId(request)
    const [link, pending] = await Promise.all([service.byWallet(wallet), id ? service.pending(id) : null])
    return Response.json({ link, pending }, { headers })
  } catch (error) { return fail(error) }
}

// confirm (sign the pending link) · cancel · unlink-challenge · unlink. Every action is same-origin and rate limited.
export async function POST(request) {
  if (!xLinksEnabled()) return notFound()
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const service = xLinksService(), body = await request.json().catch(() => ({}))
    await service.quota(`x-link:${clientKey(request)}`, X_LIMITS.link)
    if (body?.action === 'confirm') {
      const link = await service.confirm({ id: pendingId(request), signature: body.signature })
      forgetXHandle(link.wallet)
      return clearPending(NextResponse.json({ link }, { headers }))
    }
    if (body?.action === 'cancel') {
      await service.cancel(pendingId(request))
      return clearPending(NextResponse.json({ cancelled: true }, { headers }))
    }
    if (body?.action === 'unlink-challenge') {
      const { terms, message } = service.unlinkChallenge({ wallet: body.wallet })
      return Response.json({ challenge: seal(terms), message }, { headers })
    }
    if (body?.action === 'unlink') {
      const terms = unseal(body.challenge)
      if (!terms) throw new XLinkError('Signature request expired. Try again.')
      const result = await service.unlink({ terms, signature: body.signature })
      forgetXHandle(terms.wallet)
      return Response.json(result, { headers })
    }
    throw new XLinkError('Invalid action')
  } catch (error) { return fail(error) }
}
