import { database } from '../../../lib/server.mjs'
import { assertSameOrigin } from '../../../lib/auth.mjs'
import { hfSessionCookie, readHfSession } from '../../../lib/hf-auth.mjs'
import { hfRouteError, hfVerifier } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { forgetPromotionExclusions } from '../../../lib/promotion-exclusions.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { registeredMarketId } from '../../../../src/hf-verification.mjs'
import { hfMarketsEnabled, registerModel } from '../../../../src/hf-launch.mjs'
import { activeDecision, createMaintainerDecisions, DecisionError, hasLiveMarket } from '../../../../src/maintainer-opt-outs.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
// Lookups and changes each read Hugging Face; an owner has no reason to do either more often than this.
const LOOKUPS_PER_HOUR = 60
const CHANGES_PER_HOUR = 20
const reply = (body, status = 200) => Response.json(body, { status, headers })
const readSession = request => readHfSession(request.cookies.get(hfSessionCookie)?.value)
const failed = (error, context) => {
  const { status, body } = hfRouteError(error, { known: [DecisionError], fallback: 'This could not be checked right now. Refresh and try again.', context })
  return reply(body, status)
}

// /opt-out, Hugging Face section: ?model=<URL or owner/name> → the model as Hugging Face names it now (its stable _id and
// current owner), the signed-in user's authority over it, its market (if any) and its active decision.
export async function GET(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers })
  const session = readSession(request)
  if (!session) return reply({ error: 'Sign in with Hugging Face to manage a model.' }, 401)
  try {
    const pool = database()
    if (!await takeQuota(pool, [[`hf-opt-out-lookup:${session.subject}`, LOOKUPS_PER_HOUR, 3600]])) throw new DecisionError('Too many lookups. Try again later.', 429)
    const verifier = hfVerifier(request.url)
    const found = await verifier.lookupModel(request.nextUrl.searchParams.get('model') ?? '')
    const authority = await verifier.modelAuthority({ model: found, accessToken: session.accessToken, expectedSubject: session.subject })
    const marketId = await registeredMarketId(pool, found.hfId)
    const [live, decision, mint] = marketId ? await Promise.all([hasLiveMarket(pool, marketId), activeDecision(pool, marketId),
      pool.query(`select mint from markets where github_repo_id = $1 and status = 'confirmed' and indexed_at is not null and launch_finality = 'finalized'`, [marketId])
        .then(result => result.rows[0]?.mint ?? null)]) : [false, null, null]
    return reply({ username: session.username, model: { hfId: found.hfId, path: found.path, owner: { handle: found.owner.handle, kind: found.owner.kind, id: found.owner.id } },
      marketId, mint, live, decision, authority: { authorized: authority.authorized, role: authority.role, message: authority.message } })
  } catch (error) { return failed(error, 'model opt-out lookup') }
}

// { action: 'decline' | 'opt_out', model, hfId, note } records a decision; { action: 'withdraw', model, hfId } withdraws it.
// hfId is the model the owner reviewed on screen: if the URL now leads to another model, nothing changes. Same-origin POST,
// the Hugging Face session, and a fresh check that the user is the model's current owner or an admin of its organization.
export async function POST(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers })
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return reply({ error: 'Open repo.ing and try again.' }, 403) }
  const session = readSession(request)
  if (!session) return reply({ error: 'Sign in with Hugging Face again to continue.' }, 401)
  try {
    const body = await request.json().catch(() => null)
    if (!body || !['decline', 'opt_out', 'withdraw'].includes(body.action)) throw new DecisionError('Invalid request.')
    const pool = database()
    if (!await takeQuota(pool, [[`opt-out:hf:${session.subject}`, CHANGES_PER_HOUR, 3600]])) throw new DecisionError('Too many changes. Try again later.', 429)
    const verifier = hfVerifier(request.url)
    const found = await verifier.lookupModel(body.model ?? '')
    if (found.hfId !== body.hfId) throw new DecisionError('That URL now leads to a different model. Look it up again before deciding.', 409)
    // Checked before the model is registered, so nobody registers models they do not own; checked again below.
    const authority = await verifier.modelAuthority({ model: found, accessToken: session.accessToken, expectedSubject: session.subject })
    if (!authority.authorized) throw new DecisionError(authority.message, 403)
    const marketId = body.action === 'withdraw' ? await registeredMarketId(pool, found.hfId) : String(await registerModel(pool, found, found.owner))
    if (!marketId) throw new DecisionError('There is nothing to withdraw for this model.', 409)
    const decisions = createMaintainerDecisions({ pool, source: 'huggingface', verifyAdmin: ({ githubRepoId, live }) => verifier.verifyMarketAuthority({
      marketId: githubRepoId, accessToken: session.accessToken, expectedSubject: session.subject, record: live }) })
    const result = body.action === 'withdraw' ? { ...await decisions.withdraw({ repoId: marketId }), decision: null }
      : { decision: await decisions.create({ repoId: marketId, kind: body.action, note: body.note }) }
    forgetPromotionExclusions(pool)
    return reply({ ...result, marketId })
  } catch (error) { return failed(error, 'model opt-out') }
}
