import { database } from '../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { createWebhookStore, WebhookError, webhooksEnabled } from '../../../src/launch-webhooks.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
const CHANGES_PER_HOUR = 20
const readSession = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)

// Launch feed webhooks of the signed-in GitHub user (docs/MARKET_DATA_API.md#webhooks). 404 while webhooks are off.
export async function GET(request) {
  if (!webhooksEnabled()) return Response.json({ error: 'Webhooks are not enabled' }, { status: 404, headers })
  const session = readSession(request)
  if (!session || session.expiresAt <= Date.now()) return Response.json({ error: 'Sign in with GitHub to manage webhooks.' }, { status: 401, headers })
  try { return Response.json({ githubLogin: session.githubLogin, webhooks: await createWebhookStore(database()).list(session.githubUserId) }, { headers }) }
  catch { return Response.json({ error: 'Webhooks are temporarily unavailable.' }, { status: 503, headers }) }
}

// { action: 'create', url, kinds?, repoIds? } or { action: 'delete', id }.
export async function POST(request) {
  if (!webhooksEnabled()) return Response.json({ error: 'Webhooks are not enabled' }, { status: 404, headers })
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return Response.json({ error: 'Open repo.ing and try again.' }, { status: 403, headers }) }
  const session = readSession(request)
  if (!session || session.expiresAt <= Date.now()) return Response.json({ error: 'Sign in with GitHub again to continue.' }, { status: 401, headers })
  try {
    const body = await request.json().catch(() => null)
    if (!body || !['create', 'delete'].includes(body.action)) throw new WebhookError('Invalid request.')
    const pool = database()
    if (!await takeQuota(pool, [[`launch-webhooks:user:${session.githubUserId}`, CHANGES_PER_HOUR, 3600]])) throw new WebhookError('Too many changes. Try again later.', 429)
    const store = createWebhookStore(pool)
    const result = body.action === 'delete' ? await store.remove(session.githubUserId, body.id)
      : { webhook: await store.create({ githubUserId: session.githubUserId, githubLogin: session.githubLogin, url: body.url, kinds: body.kinds, repoIds: body.repoIds }) }
    return Response.json(result, { headers })
  } catch (error) {
    if (error instanceof WebhookError) return Response.json({ error: error.message }, { status: error.status, headers })
    console.error('webhook change failed', { error: error?.message })
    return Response.json({ error: 'This could not be saved. Refresh and try again.' }, { status: 503, headers })
  }
}
