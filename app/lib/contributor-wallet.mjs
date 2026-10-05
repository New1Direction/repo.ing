import { earlyAccessEnabled } from '../../src/early-access.mjs'
import { GithubWalletLinkError, LINK_ERRORS, createGithubWalletLinks } from '../../src/github-wallet-links.mjs'
import { githubSessionCookie, readGithubSession } from './auth.mjs'
import { publicError } from './public-error.mjs'
import { database } from './server.mjs'

// Web side of contributor wallet links (src/github-wallet-links.mjs): the page at /contributors/link and the API under
// /api/contributor-wallet. Dark: both answer 404 unless EARLY_ACCESS_ENABLED is "true", and the database and the GitHub App
// secret (which seals the sign-in cookie) are configured.
export const contributorWalletAvailable = () => earlyAccessEnabled() && Boolean(database()) && Boolean(process.env.GITHUB_APP_CLIENT_SECRET)
export const contributorWalletLinks = () => createGithubWalletLinks({ pool: database() })

// Any GitHub sign-in names its account (the contributor sign-in is identity only, like the builder dashboard's).
export const githubSession = request => readGithubSession(request.cookies.get(githubSessionCookie)?.value)
export function requireGithubSession(request) {
  const session = githubSession(request)
  if (!session) throw new GithubWalletLinkError(LINK_ERRORS.signIn, 401)
  return session
}

const headers = { 'Cache-Control': 'private, no-store' }
export const reply = (body, status = 200) => Response.json(body, { status, headers })
export const notFound = () => reply({ error: 'Not found' }, 404)

// Only this module's own messages reach the page; anything else is logged and replaced (app/lib/public-error.mjs).
export function failure(error) {
  if (/^Open the claim page/.test(error?.message ?? '')) return reply({ error: 'Open this page on repo.ing and try again.' }, 403)
  const safe = error instanceof GithubWalletLinkError
  return reply({ error: publicError(error, () => safe, 'Wallet linking is temporarily unavailable. Try again.', 'contributor wallet') },
    safe ? error.status : 503)
}
