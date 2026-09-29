import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { createMaintainerInvites } from '../../../../src/maintainer-invites.mjs'
import { database, feeStatus, repositoryById } from '../../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }
const session = request => requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
// Same verified source as the claim page: only a MATCH reconciliation counts.
const verifiedFee = async repoId => { const fees = await feeStatus(repoId); return fees.status === 'MATCH' ? fees.onchainCreatorFee?.toString() ?? null : null }
const invites = request => createMaintainerInvites({ pool: database(), verifiedFee, repoMeta: repositoryById, origin: publicOrigin(request.url) })

export async function GET(request) {
  try { session(request) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  try { return Response.json({ ...(await invites(request).list()), checkedAt: new Date().toISOString() }, { headers }) }
  catch { return Response.json({ error: 'Invite candidates are temporarily unavailable. Try refreshing.' }, { status: 503, headers }) }
}

export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const operator = session(request), body = await request.json()
    return Response.json({ result: await invites(request).record({ repoId: body.repoId, action: body.action, operator }) }, { headers })
  } catch (error) {
    return Response.json({ error: error.status ? error.message : 'Could not update the invite. Refresh and try again.' }, { status: error.status ?? 409, headers })
  }
}
