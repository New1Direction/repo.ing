import { NextResponse } from 'next/server'
import { malformedRouteId } from './app/lib/route-params.mjs'

// These pages stream a loading shell, which fixes the status at 200 before notFound() can run.
// Rejecting malformed ids here returns a real 404; well-formed but unknown ids still get noindex.
export const config = { matcher: ['/token/:id', '/claim/:id', '/launch/:id'] }

export function proxy(request) {
  if (malformedRouteId(request.nextUrl.pathname)) return NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 })
}
