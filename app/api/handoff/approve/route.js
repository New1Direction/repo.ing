import { NextResponse } from 'next/server'
import { callbackUrl, createHandoff } from '../../../../src/repo-inference-handoff.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { HANDOFF_COOKIE, handoffAvailable, noStore, readHandoffCookie } from '../../../lib/handoff.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { database } from '../../../lib/server.mjs'
export const runtime = 'nodejs'

// The consent form (src/repo-inference-handoff.mjs, step 2): same-origin only. Approve checks again, live, that the signed-
// in GitHub account is an admin of the repository, then sends a single-use code to the CLI's loopback address; deny sends
// the refusal. Either way the request cookie is spent.
export async function POST(request) {
  if (!handoffAvailable()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const origin = publicOrigin(request.url)
  try { assertSameOrigin(request, origin) } catch { return noStore(NextResponse.json({ error: 'Approve on repo.ing.' }, { status: 403 })) }
  const handoff = readHandoffCookie(request.cookies.get(HANDOFF_COOKIE)?.value)
  if (!handoff) return noStore(NextResponse.redirect(new URL('/handoff', origin), 303))
  const back = result => {
    const response = NextResponse.redirect(callbackUrl(handoff, result), 303)
    response.cookies.delete(HANDOFF_COOKIE)
    return noStore(response)
  }
  const form = await request.formData().catch(() => null)
  if (form?.get('decision') !== 'approve') return back({ error: 'access_denied' })
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  if (session?.scope !== 'builders') return noStore(NextResponse.redirect(new URL('/handoff', origin), 303))
  const pool = database()
  if (!await takeQuota(pool, [[`handoff:approve:${session.githubUserId}`, 10, 60]])) return back({ error: 'slow_down' })
  try { await sessionVerifier(session, request.url, { dashboard: true }).verifyCurrentAuthority({ githubRepoId: handoff.repoId }) }
  catch { return back({ error: 'not_admin' }) }
  const { code } = await createHandoff(pool, { request: handoff, githubUserId: session.githubUserId, login: session.githubLogin })
  return back({ code })
}
