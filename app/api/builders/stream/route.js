import { createRepoStreams, readRepoStream } from '../../../../src/repo-streams.mjs'
import { database } from '../../../lib/server.mjs'
import { githubSessionCookie, readGithubSession, assertSameOrigin } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'private, no-store' }
// Same authority as the other builder actions: the encrypted GitHub session, a same-origin POST, and a fresh GitHub admin
// check for the repository immediately before every change.
const DENIED = /^(Open the claim page|GitHub session|Current GitHub)/
const SAFE = /^(Use an https link|Stream links are limited|Invalid (repository|stream action|live state)|Add a stream link first|Open the claim page|GitHub session|Current GitHub)/
const ACTIONS = new Set(['save', 'live', 'remove'])

// The stream is public (token pages show it); this read only fills the settings form.
export async function GET(request) {
  const repoId = new URL(request.url).searchParams.get('repo') ?? ''
  if (!/^[1-9]\d{0,18}$/.test(repoId)) return Response.json({ error: 'Invalid repository' }, { status: 400, headers })
  try { return Response.json({ stream: await readRepoStream(database(), repoId) }, { headers }) }
  catch (error) {
    console.error('stream read failed', { error: error?.code ?? error?.name ?? 'error' })
    return Response.json({ error: 'Stream settings are unavailable. Refresh to try again.' }, { status: 503, headers })
  }
}

export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session) throw Error('GitHub session expired. Verify again.')
    const body = await request.json()
    if (!ACTIONS.has(body?.action)) throw Error('Invalid stream action')
    const verifier = sessionVerifier(session, request.url, { dashboard: session.scope === 'builders' })
    const args = { githubRepoId: body.repoId, verifyAuthority: input => verifier.verifyCurrentAuthority(input) }
    const streams = createRepoStreams({ pool: database() })
    const stream = body.action === 'save' ? await streams.save({ ...args, url: body.url })
      : body.action === 'live' ? await streams.setLive({ ...args, live: body.live }) : await streams.remove(args)
    return Response.json({ stream }, { headers })
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'Stream settings could not be saved. Refresh and try again.', 'stream settings') },
      { status: DENIED.test(error?.message ?? '') ? 403 : 400, headers })
  }
}
