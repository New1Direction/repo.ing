import { requirePlatformOperator } from '../../lib/platform-operator.mjs'
import { BUYBACK_IMPORT_REFUSALS, createPlatformRevenue, platformRevenueSummary, reconcilePlatformRevenue } from '../../../src/platform-revenue.mjs'
import { chain, database, partnerSigner } from '../../lib/server.mjs'
import { OFFICIAL_TOKEN } from '../../lib/official-token.mjs'
import { platformTreasuryWallet } from '../../../src/platform-dbc-fees.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, seal, unseal } from '../../lib/auth.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }
// Refusals whose own fixed wording (src/platform-revenue.mjs) is safe to show an operator as it is.
const SHOWN = new Set([...Object.values(BUYBACK_IMPORT_REFUSALS), 'Buyback amount exceeds the remaining reserve for this allocation',
  'Intent exceeds the remaining buyback reserve'])
// Refusals that are part of ordinary use and answered in general words: an old review, a request from another page.
const ROUTINE = new Set(['Review expired', 'Unsupported platform revenue action', 'Open the claim page on repo.ing and try again'])
// Anything else that is answered in general words, or could not be read from the chain, is logged by kind (a missing
// import, a missing setting, a database or provider error), so a route that stopped working cannot go unnoticed.
function faultKind(error) {
  const fault = error?.cause ?? error
  return fault?.status ?? fault?.code ?? (fault?.name && fault.name !== 'Error' ? fault.name : 'error')
}
const logFault = (where, error) => console.warn('platform_revenue_failed', { where, code: faultKind(error) })

function service() {
  const partner = partnerSigner()
  if (!partner) throw Error('Platform revenue is not configured')
  return createPlatformRevenue({ pool: database(), partnerWallet: platformTreasuryWallet(partner.publicKey) })
}

function session(request) {
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  return requirePlatformOperator(session)
}

function reviewed(body, action, session) {
  const review = unseal(body.review)
  if (!review || review.purpose !== `platform-revenue-${action}` || review.sessionId !== session.sessionId) throw Error('Review expired')
  return review
}

export async function GET(request) {
  try { session(request) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  try {
    const db = database()
    const [summary, reconciliation, intents] = await Promise.all([
      platformRevenueSummary(db), reconcilePlatformRevenue(db),
      db.query(`select id, idempotency_key as "idempotencyKey", allocation_group as "allocationGroup",
        amount::text as amount, status, policy_version as "policyVersion", expires_at as "expiresAt"
        from buyback_intents order by id desc limit 20`) ])
    const allocate = summary.available !== '0' && summary.activePolicy ? seal({
      purpose: 'platform-revenue-allocate', sessionId: session(request).sessionId,
      policyVersion: summary.activePolicy.version, expiresAt: Date.now() + 10 * 60_000 }) : null
    return Response.json({ ...summary, reconciliation, intents: intents.rows, reviews: { allocate,
      import: seal({ purpose: 'platform-revenue-intent.import', sessionId: session(request).sessionId,
        expiresAt: Date.now() + 10 * 60_000 }) } }, { headers })
  } catch (error) {
    logFault('summary', error)
    return Response.json({ error: 'Platform revenue is temporarily unavailable. Try refreshing.' }, { status: 503, headers })
  }
}

export async function POST(request) {
  let name = 'request'
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    // The operator is checked before the body is read: an anonymous request is answered 401 whatever it sent.
    const current = session(request)
    const body = await request.json()
    const actions = {
      'policy.create': () => {
        const review = reviewed(body, 'policy.create', current)
        if (Number(review.buybackPermille) !== body.buybackPermille || Number(review.liquidityPermille) !== body.liquidityPermille) throw Error('Review expired')
        return service().createPolicy({ buybackPermille: Number(review.buybackPermille), liquidityPermille: Number(review.liquidityPermille), createdBy: current.githubUserId })
      },
      'policy.activate': () => {
        const review = reviewed(body, 'policy.activate', current)
        if (Number(review.version) !== Number(body.version)) throw Error('Review expired')
        return service().activatePolicy({ version: Number(review.version), createdBy: current.githubUserId })
      },
      allocate: () => service().allocate({ review: reviewed(body, 'allocate', current), createdBy: current.githubUserId }),
      'intent.import': () => {
        reviewed(body, 'intent.import', current)
        // Amount and destination are not reviewable before the fact: the finalized
        // chain receipt is the authority, verified inside importBuyback.
        return service().importBuyback({ signature: String(body.signature), allocationGroup: body.allocationGroup ?? null,
          createdBy: current.githubUserId, mint: OFFICIAL_TOKEN.mint, connection: chain() })
      },
      'intent.create': () => {
        const review = reviewed(body, 'intent.create', current)
        if (review.allocationGroup !== body.allocationGroup || review.amount !== String(body.amount)) throw Error('Review expired')
        return service().createIntent({ allocationGroup: review.allocationGroup, amount: review.amount,
          idempotencyKey: review.idempotencyKey, createdBy: current.githubUserId })
      },
      'intent.review': () => {
        const review = reviewed(body, 'intent.review', current)
        if (Number(review.id) !== Number(body.id)) throw Error('Review expired')
        return service().reviewIntent({ id: Number(review.id), review: { ...review, purpose: 'buyback-intent-review',
          amount: review.amount, destinationMint: null, destinationTokenAccount: null, quoteIdentifier: null,
          expectedOutput: null, minimumOutput: null, maxSlippageBps: review.maxSlippageBps ?? null,
          maxPriceImpactBps: review.maxPriceImpactBps ?? null }, reviewedBy: current.githubUserId })
      },
      'intent.simulate': () => service().simulateIntent({ id: Number(body.id) }),
      'intent.execute': () => service().executeIntent({ id: Number(body.id) }),
    }
    if (!Object.hasOwn(actions, body?.action)) throw Error('Unsupported platform revenue action')
    name = body.action
    const action = actions[name]
    return Response.json({ result: await action() }, { headers })
  } catch (error) {
    if (error?.status) return Response.json({ error: error.message }, { status: error.status, headers })
    const said = String(error?.message ?? '')
    const message = /execution is disabled/.test(said) ? 'Buyback execution is disabled until the canonical $REPOING configuration exists.' :
      /No claimed platform revenue/.test(said) ? 'No claimed platform revenue is available to allocate.' :
      SHOWN.has(said) ? said : null
    if (error?.cause || (message === null && !ROUTINE.has(said))) logFault(name, error)
    return Response.json({ status: 'failed', error: message ?? 'Refresh this page to review platform revenue and try again.' }, { status: 409, headers })
  }
}
