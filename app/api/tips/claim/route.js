import { createTipPayouts } from '../../../../src/tip-transfers.mjs'
import { TIPS_DISABLED } from '../../../../src/tips.mjs'
import { chain, database } from '../../../lib/server.mjs'
import { tipSigner } from '../../../lib/tips.mjs'
import { githubSessionCookie, readGithubSession, readTipReview, assertSameOrigin } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
export const runtime = 'nodejs'

// Same authority as builder-fee claims: the encrypted GitHub session, a sealed review of the payout wallet, and a fresh
// admin check against GitHub immediately before the tip wallet signs anything.
const SAFE = /^(Tips are not enabled|Tip claim review|Current GitHub|GitHub session|Set a payout wallet|Payout wallet changed|No tips are waiting|Invalid tip claim)/
const PER_MINT_SAFE = /^(Tip wallet balance is below|Tip payouts are paused|Tips changed while|Token (has|accounts|transfers|is non|mint)|Recipient must be)/
export async function POST(request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  try {
    const signer = tipSigner()
    if (!signer || !database()) throw Error(TIPS_DISABLED)
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    const review = readTipReview((await request.json()).review, session)
    const verifier = sessionVerifier(session, request.url, { dashboard: session.scope === 'builders' })
    const results = await createTipPayouts({ pool: database(), connection: chain(), signer }).payout({ githubRepoId: review.repoId, review,
      verifyAuthority: args => verifier.verifyCurrentAuthority(args) })
    return Response.json({ results: results.map(r => r.status === 'failed'
      ? { mint: r.mint, status: 'failed', error: PER_MINT_SAFE.test(r.error) ? r.error : 'This token could not be paid. Refresh and try again.' }
      : { mint: r.mint, status: r.status, signature: r.signature, amount: r.amount }) }, { headers })
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'Tip claim could not finish. Refresh and try again.', 'tip claim') },
      { status: error?.message === TIPS_DISABLED ? 503 : 409, headers })
  }
}
