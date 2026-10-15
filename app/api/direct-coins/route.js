import { ZodError } from 'zod'
import { database } from '../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { readLimitedBody } from '../../../src/token-image.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { directCoinDrafts, directRequestSchema } from '../../../src/direct-coin-drafts.mjs'
import { directCoinAdapter, DirectCoinError } from '../../../src/direct-coin-adapters.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
const json = (body, status = 200) => Response.json(body, { status, headers })
const sessionFor = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)

export async function GET(request) {
  const session = sessionFor(request)
  if (!session) return json({ signedIn: false, drafts: [], events: [] })
  const pool = database()
  if (!pool) return json({ error: 'Server draft storage is unavailable. Your device draft is unchanged.' }, 503)
  try { return json({ signedIn: true, ...await directCoinDrafts(pool).list(session.githubUserId) }) }
  catch { return json({ error: 'Saved drafts are unavailable. Try again later.' }, 503) }
}

export async function POST(request) {
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return json({ error: 'Open repo.ing and try again.' }, 403) }
  const session = sessionFor(request)
  if (!session) return json({ error: 'Sign in with GitHub to save or check devnet. No wallet access is requested.' }, 401)
  let body
  try { body = directRequestSchema.parse(JSON.parse((await readLimitedBody(request, 4096)).toString('utf8'))) }
  catch { return json({ error: 'Invalid or oversized plan. Only save and inspect are supported; never send keys or transactions.' }, 400) }
  const pool = database()
  if (!pool) return json({ error: 'Draft storage and audit trail are unavailable; refusing the operation.' }, 503)
  const start = Date.now()
  let outcome = 'unavailable'
  try {
    if (!await takeQuota(pool, [[`direct-coins:${session.githubUserId}`, 120, 3600]])) return json({ error: 'Too many requests. Try again later.' }, 429)
    const store = directCoinDrafts(pool)
    if (body.action === 'save') {
      const draft = await store.save(session.githubUserId, body)
      outcome = 'saved'
      return json({ draft })
    }
    let observation
    try {
      observation = await directCoinAdapter(body.plan.adapter).inspect(body.plan, { confirmedNetwork: body.confirmedNetwork })
      outcome = observation.status
    } catch (error) {
      outcome = error instanceof DirectCoinError ? 'refused' : 'unavailable'
      await store.recordInspection(session.githubUserId, body.plan, outcome)
      throw error
    }
    await store.recordInspection(session.githubUserId, body.plan, outcome)
    return json({ observation })
  } catch (error) {
    if (error instanceof ZodError) return json({ error: 'Invalid draft.' }, 400)
    if (error instanceof DirectCoinError || [400, 409].includes(error.status)) return json({ error: error.message }, error.status)
    return json({ error: 'Devnet or draft storage is unavailable. No transaction was generated or sent.' }, 503)
  } finally {
    console.info(JSON.stringify({ directCoin: { action: body.action, adapter: body.plan.adapter, outcome, durationMs: Date.now() - start } }))
  }
}
