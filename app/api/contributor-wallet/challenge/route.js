import { GithubWalletLinkError, LINK_ERRORS, LINK_LIMITS } from '../../../../src/github-wallet-links.mjs'
import { assertSameOrigin } from '../../../lib/auth.mjs'
import { contributorWalletAvailable, contributorWalletLinks, failure, notFound, reply, requireGithubSession } from '../../../lib/contributor-wallet.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// { wallet } → the message that wallet signs to become the signed-in account's contributor wallet (valid 5 minutes). The
// account is read from GitHub again first: the token still works, for the same user id, and the account is not a bot.
export async function POST(request) {
  if (!contributorWalletAvailable()) return notFound()
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const session = requireGithubSession(request), links = contributorWalletLinks()
    await links.quota([[`contributor-wallet:challenge:${clientKey(request)}`, ...LINK_LIMITS.challenge],
      [`contributor-wallet:account:${session.githubUserId}`, ...LINK_LIMITS.challengeAccount]])
    const body = await request.json().catch(() => ({}))
    let identity
    try { identity = await sessionVerifier(session, request.url).currentIdentity() }
    catch { throw new GithubWalletLinkError(LINK_ERRORS.account, 401) }
    const challenge = await links.challenge({ identity, wallet: body?.wallet })
    return reply({ wallet: challenge.wallet, nonce: challenge.nonce, message: challenge.message, expiresAt: challenge.expiresAt })
  } catch (error) { return failure(error) }
}
