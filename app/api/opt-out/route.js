import { database } from '../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { sessionVerifier } from '../../lib/github-session.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { forgetPromotionExclusions } from '../../lib/promotion-exclusions.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { activeDecisions, createMaintainerDecisions, DecisionError } from '../../../src/maintainer-opt-outs.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
// Each change runs fresh GitHub checks; a maintainer has no reason to toggle more often than this.
const CHANGES_PER_HOUR = 20
const readSession = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)

// /opt-out: the signed-in user's public repositories with GitHub admin access (the builder dashboard's listing), each with
// its public market and active decision.
export async function GET(request) {
  const session = readSession(request)
  if (!session) return Response.json({ error: 'Sign in with GitHub to see your repositories.' }, { status: 401, headers })
  try {
    const pool = database()
    const repos = await sessionVerifier(session, request.url, { dashboard: true }).listAdminRepositories()
    const ids = repos.map(repo => repo.repoId)
    const [{ rows }, decisions] = await Promise.all([pool.query(`select github_repo_id::text as "repoId", mint from markets
      where github_repo_id = any($1::bigint[]) and status = 'confirmed' and indexed_at is not null and launch_finality = 'finalized'`, [ids]),
    activeDecisions(pool, ids)])
    const mints = new Map(rows.map(row => [row.repoId, row.mint]))
    return Response.json({ githubLogin: session.githubLogin, repositories: repos.map(repo => ({ ...repo,
      mint: mints.get(repo.repoId) ?? null, decision: decisions.get(repo.repoId) ?? null })) }, { headers })
  } catch (error) {
    console.error('opt-out listing failed', { error: error?.message })
    return Response.json({ error: 'Could not check your GitHub repositories. Refresh or sign in with GitHub again.' }, { status: 503, headers })
  }
}

// { action: 'decline' | 'opt_out', repoId, note } records a decision; { action: 'withdraw', repoId } withdraws it. The same
// session pattern as the builder actions: same-origin POST, GitHub session cookie, and a fresh check of current admin access.
export async function POST(request) {
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return Response.json({ error: 'Open repo.ing and try again.' }, { status: 403, headers }) }
  const session = readSession(request)
  if (!session) return Response.json({ error: 'Sign in with GitHub again to continue.' }, { status: 401, headers })
  try {
    const body = await request.json().catch(() => null)
    if (!body || !['decline', 'opt_out', 'withdraw'].includes(body.action)) throw new DecisionError('Invalid request.')
    const pool = database()
    if (!await takeQuota(pool, [[`opt-out:user:${session.githubUserId}`, CHANGES_PER_HOUR, 3600]])) throw new DecisionError('Too many changes. Try again later.', 429)
    const verifier = sessionVerifier(session, request.url, { dashboard: true })
    // A repository with a market goes through the claim flow's verifier (which also records the verification).
    const decisions = createMaintainerDecisions({ pool, verifyAdmin: ({ githubRepoId, live }) =>
      live ? verifier.verifyCurrentAuthority({ githubRepoId }) : verifier.verifyRepositoryAdmin({ githubRepoId }) })
    const result = body.action === 'withdraw' ? { ...await decisions.withdraw({ repoId: body.repoId }), decision: null }
      : { decision: await decisions.create({ repoId: body.repoId, kind: body.action, note: body.note }) }
    forgetPromotionExclusions(pool)
    return Response.json(result, { headers })
  } catch (error) {
    if (error instanceof DecisionError) return Response.json({ error: error.message }, { status: error.status, headers })
    console.error('maintainer decision failed', { error: error?.message })
    return Response.json({ error: 'This could not be saved. Refresh and try again.' }, { status: 503, headers })
  }
}
