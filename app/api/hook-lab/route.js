import { z, ZodError } from 'zod'
import { database } from '../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { refuseOverLimit } from '../../lib/request-limits.mjs'
import { readLimitedBody } from '../../../src/token-image.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { importHookLabRecipe, hookLabRecipeSaveSchema } from '../../../src/hook-lab-recipe.mjs'
import { hookLabRecipeDrafts } from '../../../src/hook-lab-recipe-drafts.mjs'
import { inspectHookLabRecipe, hookLabLaunchQuote } from '../../../src/hook-lab-preflight.mjs'
import { directCoinConnection } from '../../../src/direct-coin-adapters.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
const sessionFor = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)
// Serialized envelope preserves duplicate-member detection at the import boundary.
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id: z.uuid(), revision: z.number().int().nonnegative(), envelopeText: z.string() }).strict(),
  z.object({ action: z.literal('inspect'), confirmedNetwork: z.literal('devnet'), envelopeText: z.string() }).strict(),
  z.object({ action: z.literal('quote'), confirmedNetwork: z.literal('devnet'), envelopeText: z.string() }).strict(),
])

export async function GET(request) {
  const session = sessionFor(request)
  if (!session) return json({ signedIn: false, drafts: [], events: [] })
  try {
    const pool = database()
    if (!pool) throw new Error('Storage unavailable')
    return json({ signedIn: true, ...await hookLabRecipeDrafts(pool).list(session.githubUserId) })
  } catch { return json({ error: 'Account recipes are unavailable. Device drafts are unchanged.' }, 503) }
}

export async function POST(request) {
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return json({ error: 'Open repo.ing and try again.' }, 403) }
  let body, envelope
  try {
    body = requestSchema.parse(JSON.parse((await readLimitedBody(request, 400000)).toString('utf8')))
    envelope = importHookLabRecipe(body.envelopeText)
  } catch { return json({ error: 'Invalid recipe or request. Unknown versions and duplicate JSON members are refused. Never include secrets or transactions.' }, 400) }
  const started = Date.now()
  let outcome = 'unavailable'
  try {
    if (body.action === 'quote') { outcome = 'blocked'; return json({ quote: hookLabLaunchQuote }, 422) }
    if (body.action === 'inspect') {
      const limited = refuseOverLimit(request, 'direct-coins:inspect')
      if (limited) { outcome = 'limited'; return limited }
      const observation = await inspectHookLabRecipe(envelope, directCoinConnection(), body.confirmedNetwork)
      outcome = observation.inspection.refusals.length || observation.intent.refusals.length ? 'refused' : 'observed'
      return json({ observation })
    }
    const session = sessionFor(request)
    if (!session) return json({ error: 'GitHub is optional. Sign in only for account recipe storage; device drafts and inspection do not require it.' }, 401)
    const pool = database()
    if (!pool) throw new Error('Storage unavailable')
    if (!await takeQuota(pool, [[`hook-lab-recipes:${session.githubUserId}`, 120, 3600]])) return json({ error: 'Too many saves. Try again later.' }, 429)
    const draft = await hookLabRecipeDrafts(pool).save(session.githubUserId, hookLabRecipeSaveSchema.parse({ id: body.id, revision: body.revision, envelope }))
    outcome = 'saved'
    return json({ draft })
  } catch (error) {
    if (error instanceof ZodError) return json({ error: 'Invalid recipe save.' }, 400)
    if (error.status === 409) return json({ error: error.message }, 409)
    return json({ error: 'Inspection or recipe storage is unavailable. No transaction was constructed or sent.' }, 503)
  } finally {
    console.info(JSON.stringify({ hookLab: { action: body.action, outcome, durationMs: Date.now() - started } }))
  }
}
