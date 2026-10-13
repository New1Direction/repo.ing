import { database } from '../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { sessionVerifier } from '../../lib/github-session.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { resolvePublicRepositoryById } from '../../../src/github.mjs'
import { persistLaunchRepository } from '../../../src/repository-store.mjs'
import { activeDecisions } from '../../../src/maintainer-opt-outs.mjs'
import { createLaunchSchedules, schedulesEnabled, schedulesForRepos, ScheduleError } from '../../../src/launch-schedules.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
const CHANGES_PER_HOUR = 20
const readSession = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)

// /launches/manage: the signed-in user's public admin repositories, each with its market (if any), maintainer decision and schedule.
export async function GET(request) {
  const session = readSession(request)
  if (!session) return Response.json({ error: 'Sign in with GitHub to see your repositories.' }, { status: 401, headers })
  try {
    const pool = database()
    const repos = await sessionVerifier(session, request.url, { dashboard: true }).listAdminRepositories()
    const ids = repos.map(repo => repo.repoId)
    const [{ rows }, decisions, schedules] = await Promise.all([pool.query(`select github_repo_id::text as "repoId", mint, status from markets
      where github_repo_id = any($1::bigint[]) and status <> 'failed'`, [ids]), activeDecisions(pool, ids), schedulesForRepos(pool, ids)])
    const markets = new Map(rows.map(row => [row.repoId, row]))
    return Response.json({ githubLogin: session.githubLogin, schedulingEnabled: schedulesEnabled(), repositories: repos.map(repo => ({ ...repo,
      mint: markets.get(repo.repoId)?.status === 'confirmed' ? markets.get(repo.repoId).mint : null, launchInProgress: markets.has(repo.repoId),
      optedOut: decisions.has(repo.repoId), schedule: schedules.get(repo.repoId) ?? null })) }, { headers })
  } catch (error) {
    console.error('launch schedule listing failed', { error: error?.message })
    return Response.json({ error: 'Could not check your GitHub repositories. Refresh or sign in with GitHub again.' }, { status: 503, headers })
  }
}

// { action: 'schedule', repoId, scheduledAt, windowMinutes, launcherWallet, maxInitialBuyLamports, note } or { action: 'cancel', repoId }.
// Same-origin POST with the GitHub session cookie; every change re-checks current admin permission with GitHub.
export async function POST(request) {
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return Response.json({ error: 'Open repo.ing and try again.' }, { status: 403, headers }) }
  const session = readSession(request)
  if (!session) return Response.json({ error: 'Sign in with GitHub again to continue.' }, { status: 401, headers })
  try {
    const body = await request.json().catch(() => null)
    if (!body || !['schedule', 'cancel'].includes(body.action)) throw new ScheduleError('Invalid request.')
    if (body.action === 'schedule' && !schedulesEnabled()) throw new ScheduleError('Scheduling launches is paused.', 503)
    const pool = database()
    if (!await takeQuota(pool, [[`launch-schedule:user:${session.githubUserId}`, CHANGES_PER_HOUR, 3600]])) throw new ScheduleError('Too many changes. Try again later.', 429)
    const verifier = sessionVerifier(session, request.url, { dashboard: true })
    const schedules = createLaunchSchedules({ pool, verifyAdmin: ({ githubRepoId }) => verifier.verifyRepositoryAdmin({ githubRepoId }),
      persistRepository: async repoId => persistLaunchRepository(pool, await resolvePublicRepositoryById(repoId)) })
    const schedule = body.action === 'cancel' ? await schedules.cancel({ repoId: body.repoId }) : await schedules.create(body)
    return Response.json({ schedule }, { headers })
  } catch (error) {
    if (error instanceof ScheduleError) return Response.json({ error: error.message, code: error.code ?? null }, { status: error.status, headers })
    console.error('launch schedule change failed', { error: error?.message })
    return Response.json({ error: 'This could not be saved. Refresh and try again.' }, { status: 503, headers })
  }
}
