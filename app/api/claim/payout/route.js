import bs58 from 'bs58'
import { PayoutRefused, createBuilderPayouts, payoutControls, solanaPayoutChain } from '../../../../src/builder-payouts.mjs'
import { chain, claimsDatabase, payoutSigner, verificationChain } from '../../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'

// Builder claim from the capped payout wallet, for the repository the GitHub session was verified for.
//   { action: 'challenge', githubRepoId }                    → { nonce, message, expiresAt, wallet }
//   { action: 'claim', githubRepoId, nonce, signature(b64) } → { status, signature, lamports }
// Errors answer only a PayoutRefused code (the page explains each), never internals.
export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    if (!(await payoutControls(claimsDatabase())).enabled) throw new PayoutRefused('payouts-off', 'Builder payouts are switched off')
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session || session.permission !== 'admin') throw new PayoutRefused('github-admin-required', 'GitHub admin session required')
    const body = await request.json()
    if (String(body?.githubRepoId) !== session.repoId) throw new PayoutRefused('github-admin-required', 'Repository mismatch')
    const signer = payoutSigner(), verification = verificationChain()
    if (!signer || !verification) throw new PayoutRefused('payouts-unavailable', 'Payouts are not configured')
    const payouts = createBuilderPayouts({ pool: claimsDatabase(), payoutSigner: signer, githubVerifier: sessionVerifier(session, request.url),
      chain: solanaPayoutChain({ connection: chain(), verification }) })
    if (body.action === 'challenge') {
      const c = await payouts.requestChallenge({ githubRepoId: session.repoId })
      return Response.json({ nonce: c.nonce, message: c.message, expiresAt: c.expiresAt, wallet: c.wallet }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'claim') {
      if (typeof body.signature !== 'string') throw new PayoutRefused('invalid-signature', 'Signature required')
      const result = await payouts.claim({ githubRepoId: session.repoId, nonce: body.nonce,
        signature: bs58.encode(Buffer.from(body.signature, 'base64')) })
      return Response.json({ status: result.status, signature: result.signature, lamports: String(result.amountLamports) },
        { headers: { 'Cache-Control': 'no-store' } })
    }
    throw new PayoutRefused('unsupported-action', 'Unsupported action')
  } catch (error) {
    if (!(error instanceof PayoutRefused)) console.error('builder payout failed', { message: error?.message })
    return Response.json({ error: error instanceof PayoutRefused ? error.code : 'claim-failed' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
}
