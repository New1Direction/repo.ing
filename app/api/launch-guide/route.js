import { database } from '../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { sessionVerifier } from '../../lib/github-session.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { launchGuideFor } from '../../lib/launch-guide.mjs'
import { recordGuide } from '../../lib/launch-guide-events.mjs'
import { guideSource } from '../../lib/launch-guide-funnel.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { activeDecisions } from '../../../src/maintainer-opt-outs.mjs'
import { schedulesForRepos, ScheduleError } from '../../../src/launch-schedules.mjs'
import { createGuideDrafts, GuideError, publicGuideRepository } from '../../../src/launch-guide.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
// Per GitHub account, shared by every web replica: selecting, checking and saving are cheap but read GitHub; publishing is rarer.
const CHANGES_PER_HOUR = 240
const PUBLISHES_PER_HOUR = 20
const readSession = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)
const signIn = { error: 'Your GitHub sign-in ended (it lasts an hour). Sign in again: your draft is saved.', code: 'SIGN_IN' }

// The signed-in maintainer's open drafts and, with ?repositories=1, the public repositories they administer that repo.ing's
// read-only GitHub App can see (one GitHub request per 100 repositories), each with its market, opt-out and schedule.
export async function GET(request) {
  const session = readSession(request)
  if (!session) return Response.json({ signedIn: false }, { headers })
  const pool = database()
  if (!pool) return Response.json({ error: 'The guided launch is unavailable right now.' }, { status: 503, headers })
  try {
    const drafts = await createGuideDrafts(pool).list(session.githubUserId)
    let repositories = null
    if (new URL(request.url).searchParams.get('repositories') === '1') {
      const repos = await sessionVerifier(session, request.url, { dashboard: true }).listAdminRepositories()
      const ids = repos.map(repo => repo.repoId)
      const [{ rows }, decisions, schedules] = await Promise.all([pool.query(`select github_repo_id::text as "repoId", mint, status from markets
        where github_repo_id = any($1::bigint[]) and status <> 'failed'`, [ids]), activeDecisions(pool, ids), schedulesForRepos(pool, ids)])
      const markets = new Map(rows.map(row => [row.repoId, row]))
      repositories = repos.map(repo => ({ ...repo, mint: markets.get(repo.repoId)?.status === 'confirmed' ? markets.get(repo.repoId).mint : null,
        launchInProgress: markets.has(repo.repoId) && markets.get(repo.repoId).status !== 'confirmed', optedOut: decisions.has(repo.repoId),
        schedule: schedules.get(repo.repoId) ?? null }))
    }
    return Response.json({ signedIn: true, githubLogin: session.githubLogin, drafts, repositories }, { headers })
  } catch (error) {
    if (/session expired/i.test(error?.message ?? '')) return Response.json(signIn, { status: 401, headers })
    console.error('launch guide listing failed', { error: error?.message })
    return Response.json({ error: 'Could not read your GitHub repositories just now. Try again.', code: 'GITHUB_UNAVAILABLE' }, { status: 503, headers })
  }
}

// { action: 'select', repoId } | { action: 'save', draftId, step?, plan? } | { action: 'check', draftId, plan?, refresh? } |
// { action: 'publish', draftId } | { action: 'discard', draftId }; each may carry source (?src= attribution).
export async function POST(request) {
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return Response.json({ error: 'Open repo.ing and try again.' }, { status: 403, headers }) }
  const session = readSession(request)
  if (!session) return Response.json(signIn, { status: 401, headers })
  const pool = database()
  const guide = launchGuideFor(session, request)
  if (!pool || !guide) return Response.json({ error: 'The guided launch is unavailable right now.' }, { status: 503, headers })
  let body
  try { body = await request.json() } catch { body = null }
  const action = body?.action
  if (!['select', 'save', 'check', 'publish', 'discard'].includes(action)) return Response.json({ error: 'Invalid request.' }, { status: 400, headers })
  const source = guideSource(body.source)
  try {
    const scopes = [[`launch-guide:user:${session.githubUserId}`, CHANGES_PER_HOUR, 3600]]
    if (action === 'publish') scopes.push([`launch-guide:publish:${session.githubUserId}`, PUBLISHES_PER_HOUR, 3600])
    if (!await takeQuota(pool, scopes)) throw new GuideError('Too many changes in an hour. Try again later.', 429)
    if (action === 'select') {
      const { draft, maintainer } = await guide.select(session, body.repoId, { source })
      return Response.json({ draft, maintainer }, { headers })
    }
    if (action === 'save') return Response.json({ draft: await guide.drafts.save(body.draftId, session.githubUserId, { step: body.step, plan: body.plan }) }, { headers })
    if (action === 'check') {
      const { draft, preflight, profile, repository } = await guide.check(session, body.draftId, { plan: body.plan, refresh: body.refresh === true, source })
      return Response.json({ draft, preflight, profile, repository: publicGuideRepository(repository) }, { headers })
    }
    if (action === 'publish') {
      const result = await guide.publish(session, body.draftId, { source })
      return Response.json(result, { headers })
    }
    const draft = await guide.drafts.get(body.draftId, session.githubUserId)
    const discarded = await guide.drafts.discard(body.draftId, session.githubUserId)
    if (discarded) await recordGuide(request, { event: 'draft_discarded', source, repoId: draft?.repoId ?? null })
    return Response.json({ discarded }, { headers })
  } catch (error) {
    if (error instanceof GuideError || error instanceof ScheduleError) {
      return Response.json({ error: error.message, code: error.code ?? null, ...(error.detail ? { detail: error.detail } : {}) }, { status: error.status, headers })
    }
    if (/session expired/i.test(error?.message ?? '')) return Response.json(signIn, { status: 401, headers })
    console.error('launch guide change failed', { action, error: error?.message })
    return Response.json({ error: action === 'publish' ? 'Publishing could not finish. Try again: publishing twice never creates two schedules.' : 'This could not be saved. Try again.' },
      { status: 503, headers })
  }
}
