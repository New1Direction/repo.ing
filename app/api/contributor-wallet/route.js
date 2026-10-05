import { LINK_LIMITS } from '../../../src/github-wallet-links.mjs'
import { assertSameOrigin } from '../../lib/auth.mjs'
import { contributorWalletAvailable, contributorWalletLinks, failure, githubSession, notFound, reply, requireGithubSession } from '../../lib/contributor-wallet.mjs'
import { clientKey } from '../../lib/holder-notes.mjs'
import { publicOrigin } from '../../lib/origin.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The signed-in GitHub account and its linked wallet (null without one); signedIn false without a GitHub sign-in.
export async function GET(request) {
  if (!contributorWalletAvailable()) return notFound()
  try {
    const session = githubSession(request)
    if (!session) return reply({ signedIn: false, githubLogin: null, link: null })
    return reply({ signedIn: true, githubLogin: session.githubLogin, link: await contributorWalletLinks().linkFor(session.githubUserId) })
  } catch (error) { return failure(error) }
}

// Removes the signed-in account's link.
export async function DELETE(request) {
  if (!contributorWalletAvailable()) return notFound()
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const session = requireGithubSession(request), links = contributorWalletLinks()
    await links.quota([[`contributor-wallet:unlink:${clientKey(request)}`, ...LINK_LIMITS.unlink]])
    return reply(await links.unlink({ githubUserId: session.githubUserId }))
  } catch (error) { return failure(error) }
}
