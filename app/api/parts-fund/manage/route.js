import { PARTS_DISABLED, validUuid } from '../../../../src/parts-fund.mjs'
import { assertMaintainer, cancelFund, collectFund, createFund, editFund, postUpdate } from '../../../../src/parts-admin.mjs'
import { decideDueFunds, finalizeFunds, sendFundTransfers } from '../../../../src/parts-settlement.mjs'
import { chain, database } from '../../../lib/server.mjs'
import { tipSigner } from '../../../lib/tips.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, readTipReview } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
export const runtime = 'nodejs'

// Maintainer actions. Same authority as builder and tip claims: the encrypted GitHub session, a fresh GitHub admin
// check immediately before any change, a bound payout wallet, and (for close & collect) a sealed review pinning it.
const SAFE = /^(Parts funds are not enabled|Invalid (repository|parts|update)|Enter |Add |A parts list|Part \d|Parts lists (are capped|cannot)|Purchase link|Image links|Title|Description|Update|Deadline|Current GitHub|GitHub session|Set a payout wallet|This repository (already|has no market)|Parts list not found|This parts list is closed|Close & collect|Payout wallet changed|Collect review|Build update|Update limit|Open the claim page|Tip claim review)/
const TRANSFER_SAFE = /^(Tip wallet balance is below|Tip payouts are paused|Pledges changed while|Token (has|accounts|transfers|is non|mint)|Recipient must be)/
const ACTIONS = new Set(['create', 'edit', 'cancel', 'collect', 'settle', 'update'])

// Sends what the list now owes (payouts or refunds), bounded; anything left or failed is retried by the worker.
async function sendNow(pool, fundId, actor) {
  const signer = tipSigner()
  const results = await sendFundTransfers({ pool, connection: chain(), signer, fundId, maxTransfers: 10, requestedBy: actor })
    .catch(error => [{ status: 'failed', error: error.message }])
  await finalizeFunds({ pool }).catch(() => null)
  return results.map(r => r.status === 'failed'
    ? { mint: r.mint ?? null, kind: r.kind ?? null, status: 'failed', error: TRANSFER_SAFE.test(r.error ?? '') ? r.error : 'Not sent yet; it will be retried automatically.' }
    : { mint: r.mint, kind: r.kind, status: r.status, signature: r.signature, amount: r.amount })
}

export async function POST(request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  try {
    const pool = database()
    if (!tipSigner() || !pool) throw Error(PARTS_DISABLED)
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session) throw Error('GitHub session expired. Verify again.')
    const body = await request.json()
    if (!ACTIONS.has(body.action)) throw Error('Invalid parts action')
    const githubRepoId = String(body.repoId ?? '')
    if (!/^[1-9]\d{0,18}$/.test(githubRepoId)) throw Error('Invalid repository')
    if (body.action !== 'create' && !validUuid(body.fundId)) throw Error('Parts list not found')
    const verifier = sessionVerifier(session, request.url, { dashboard: session.scope === 'builders' })
    const verifyAuthority = args => verifier.verifyCurrentAuthority(args)
    const actor = `github:${session.githubUserId}`
    const args = { pool, githubRepoId, fundId: body.fundId, verifyAuthority }
    let result
    if (body.action === 'create') result = await createFund({ pool, githubRepoId, input: body.list, verifyAuthority })
    else if (body.action === 'edit') result = await editFund({ ...args, input: body.list })
    else if (body.action === 'update') result = await postUpdate({ ...args, input: body.update })
    else if (body.action === 'cancel') result = { ...await cancelFund(args), transfers: await sendNow(pool, body.fundId, actor) }
    else if (body.action === 'collect') {
      const review = readTipReview(body.review, session, 'parts-collect-review')
      result = { ...await collectFund({ ...args, review }), transfers: await sendNow(pool, body.fundId, actor) }
    } else {
      // "Send now": decide a list past its deadline and send what it owes, for when the worker has not yet.
      await assertMaintainer({ githubRepoId, verifyAuthority })
      const { rows: [fund] } = await pool.query('select github_repo_id::text as repo from parts_funds where id=$1', [body.fundId])
      if (fund?.repo !== githubRepoId) throw Error('Parts list not found')
      await decideDueFunds({ pool, fundId: body.fundId })
      result = { transfers: await sendNow(pool, body.fundId, actor) }
    }
    return Response.json(result, { headers })
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'The parts list could not be updated. Refresh and try again.', 'parts manage') },
      { status: error?.message === PARTS_DISABLED ? 503 : 409, headers })
  }
}
