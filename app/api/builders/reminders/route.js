import { database } from '../../../lib/server.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { githubSessionCookie, readGithubSession, assertSameOrigin } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { createBuilderReminders, createReminderSender, remindersConfigured } from '../../../../src/builder-reminders.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
function service(request) {
  return createBuilderReminders({ pool: database(), send: createReminderSender(),
    secret: process.env.BUILDER_REMINDER_SECRET, origin: publicOrigin(request.url) })
}
export async function GET(request) {
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  if (!session) return Response.json({ error: 'Connect GitHub to manage reminders.' }, { status: 401, headers })
  try { return Response.json({ enabled: remindersConfigured(), ...await service(request).status(session.githubUserId) }, { headers }) }
  catch { return Response.json({ error: 'Reminder settings are unavailable.' }, { status: 503, headers }) }
}
export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const body = await request.json(), reminders = service(request)
    if (['confirm', 'unsubscribe'].includes(body.action)) return Response.json(await reminders.act(body.token, body.action), { headers })
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session) return Response.json({ error: 'Connect GitHub to manage reminders.' }, { status: 401, headers })
    if (body.action === 'remove') { await reminders.remove(session.githubUserId); return Response.json({ status: 'off' }, { headers }) }
    if (body.action !== 'subscribe') throw Error('Unknown reminder action.')
    if (!remindersConfigured()) return Response.json({ error: 'Email reminders are not available yet.' }, { status: 503, headers })
    const { rows: [repo] } = await database().query('select github_repo_id::text as id from repo_beneficiaries where github_user_id=$1 order by github_repo_id limit 1', [session.githubUserId])
    if (!repo) return Response.json({ error: 'Set up a repository payout wallet before enabling reminders.' }, { status: 400, headers })
    await sessionVerifier(session, request.url, { dashboard: true }).verifyCurrentAuthority({ githubRepoId: repo.id })
    return Response.json(await reminders.subscribe(session.githubUserId, body.email), { headers })
  } catch (error) {
    const safe = ['Enter a valid email address.', 'Please wait ten minutes before requesting another email.',
      'Email could not be sent. Please try again later.', 'This reminder link is invalid or expired.',
      'This confirmation expired. Request a new email from Builders.']
    return Response.json({ error: safe.includes(error.message) ? error.message : 'Could not update reminders. Refresh or reconnect GitHub and try again.' }, { status: 400, headers })
  }
}
