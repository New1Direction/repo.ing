import { createBuilderAllocation, allocationRecord } from '../../../../src/builder-allocation.mjs'
import { database, chain, configAddress, creatorSigner } from '../../../lib/server.mjs'
import { allocationView } from '../../../lib/allocation.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, unseal } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }
export async function GET(request, { params }) {
  try {
    const { repo } = await params
    if (!/^[1-9]\d*$/.test(repo)) return Response.json({ error: 'Invalid repository' }, { status: 400, headers })
    return Response.json(await allocationView(repo, readGithubSession(request.cookies.get(githubSessionCookie)?.value)), { headers })
  } catch { return Response.json({ error: 'Allocation status is temporarily unavailable. Try refreshing.' }, { status: 503, headers }) }
}
export async function POST(request, { params }) {
  let review, repo
  try {
    ({ repo } = await params)
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    review = unseal((await request.json()).review)
    if (!session || review?.purpose !== 'builder-allocation-review' || review.sessionId !== session.sessionId ||
        review.githubUserId !== session.githubUserId || review.repoId !== repo ||
        !(session.scope === 'builders' || session.repoId === repo)) throw Error('Review expired')
    const result = await createBuilderAllocation({ pool: database(), connection: chain(), config: configAddress(), creator: creatorSigner(),
      githubVerifier: sessionVerifier(session, request.url, { dashboard: true }) }).claim({ review, githubAuthorization: { session: true } })
    return Response.json(result, { headers })
  } catch (error) {
    if (review?.repoId === repo && review?.purpose === 'builder-allocation-review') {
      const record = await allocationRecord(database(), repo).catch(() => null)
      if (['pending','settled'].includes(record?.latest?.status)) return Response.json(record.latest, { headers })
    }
    const message = /authority|GitHub|wallet/.test(error.message) ? 'Reconnect GitHub and confirm your saved payout wallet before claiming.' :
      /locked/.test(error.message) ? 'The builder allocation unlocks after verified graduation.' :
      /preflight/.test(error.message) ? 'Payout could not pass its checks. Your allocation is preserved; try again later.' :
      'Refresh this page to review the allocation and try again.'
    return Response.json({ status: 'failed', error: message }, { status: 409, headers })
  }
}
