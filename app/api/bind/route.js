import { createWalletBinding } from '../../../src/wallet-binding.mjs'
import { database } from '../../lib/server.mjs'
import { githubSessionCookie, readGithubSession, assertSameOrigin } from '../../lib/auth.mjs'
import { sessionVerifier } from '../../lib/github-session.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { publicError } from '../../lib/public-error.mjs'
const SAFE = /^(Fresh GitHub|Recent GitHub|Current GitHub|GitHub session|GitHub ID|GitHub App is not configured|Repository verification mismatch|Unsupported binding action|Invalid wallet|Invalid Solana|Invalid public key|Wallet challenge|Choose up to|A payout wallet|Payout wallet|Open the claim page|Claim review|Your claim review)/
export const runtime = 'nodejs'
export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session || session.permission !== 'admin') throw new Error('Fresh GitHub admin verification required')
    const body = await request.json()
    if (String(body.githubRepoId) !== session.repoId) throw new Error('Repository verification mismatch')
    await sessionVerifier(session, request.url).verifyCurrentAuthority({ githubRepoId: session.repoId })
    const binder = createWalletBinding({ pool: database() })
    if (body.action === 'challenge') {
      const challenge = await binder.requestChallenge({ githubRepoId: session.repoId, githubUserId: session.githubUserId, wallet: body.wallet })
      return Response.json({ nonce: challenge.nonce, message: challenge.message, expiresAt: challenge.expiresAt })
    }
    if (body.action === 'bind') {
      const result = await binder.bindWallet({ githubRepoId: session.repoId, githubUserId: session.githubUserId,
        wallet: body.wallet, nonce: body.nonce, signature: Buffer.from(body.signature, 'base64') })
      return Response.json({ wallet: result.wallet, boundAt: result.boundAt })
    }
    throw new Error('Unsupported binding action')
  } catch (error) { return Response.json({ error: publicError(error, SAFE, 'Wallet binding failed. Refresh and try again.', 'bind') }, { status: 400 }) }
}
