import { NextResponse } from 'next/server'
import { malformedRouteId } from './app/lib/route-params.mjs'
import { assertNeuronEdge } from './app/lib/neuron-bot-protection.mjs'

// These pages stream a loading shell, which fixes the status at 200 before notFound() can run.
// Rejecting malformed ids here returns a real 404; well-formed but unknown ids still get noindex.
export const config = { matcher: ['/token/:id', '/claim/:id', '/launch/:id', '/neurons/:path*', '/api/neuron-characters/:path*', '/api/hook-lab/wallet-identity/:path*'] }

export function proxy(request) {
  const path = request.nextUrl.pathname
  if (path === '/neurons' || path.startsWith('/neurons/') || path === '/api/neuron-characters'
    || path.startsWith('/api/neuron-characters/') || path === '/api/hook-lab/wallet-identity' || path.startsWith('/api/hook-lab/wallet-identity/')) {
    try { assertNeuronEdge(request) }
    catch (error) { return new NextResponse('Character publishing is available only through the configured protected site.',
      { status: error.status === 403 ? 403 : 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }) }
  }
  if (malformedRouteId(request.nextUrl.pathname)) return NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 })
}
