import { LINK_LIMITS } from '../../../../src/github-wallet-links.mjs'
import { assertSameOrigin } from '../../../lib/auth.mjs'
import { contributorWalletAvailable, contributorWalletLinks, failure, notFound, reply, requireGithubSession } from '../../../lib/contributor-wallet.mjs'
import { clientKey } from '../../../lib/holder-notes.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// { wallet, nonce, signature (base64) } → the signed-in account's link. The challenge must be this account's and this
// wallet's, unused and unexpired; it is used up by a successful link.
export async function POST(request) {
  if (!contributorWalletAvailable()) return notFound()
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const session = requireGithubSession(request), links = contributorWalletLinks()
    await links.quota([[`contributor-wallet:link:${clientKey(request)}`, ...LINK_LIMITS.link]])
    const body = await request.json().catch(() => ({}))
    const link = await links.link({ githubUserId: session.githubUserId, wallet: body?.wallet, nonce: body?.nonce, signature: body?.signature })
    return reply({ link })
  } catch (error) { return failure(error) }
}
