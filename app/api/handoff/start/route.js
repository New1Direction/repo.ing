import { NextResponse } from 'next/server'
import { readHandoffRequest } from '../../../../src/repo-inference-handoff.mjs'
import { cookieOptions, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { HANDOFF_COOKIE, handoffAvailable, noStore, sealHandoffRequest } from '../../../lib/handoff.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'

// The CLI opens this (src/repo-inference-handoff.mjs, step 1): the request is kept in a sealed cookie, then the builder
// signs in with GitHub (identity only) unless already signed in that way, and lands on the consent page.
export async function GET(request) {
  if (!handoffAvailable()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const origin = publicOrigin(request.url)
  let handoff
  try { handoff = readHandoffRequest(request.nextUrl.searchParams) }
  catch (error) { return noStore(NextResponse.json({ error: error.message }, { status: 400 })) }
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  const next = session?.scope === 'builders' ? new URL('/handoff', origin) : new URL('/api/github/start?mode=handoff', origin)
  const response = NextResponse.redirect(next)
  response.cookies.set(HANDOFF_COOKIE, sealHandoffRequest(handoff), { ...cookieOptions, maxAge: 600 })
  return noStore(response)
}
