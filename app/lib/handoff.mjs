import { HANDOFF_REQUEST_SECONDS, handoffEnabled } from '../../src/repo-inference-handoff.mjs'
import { seal, unseal } from './auth.mjs'
import { database } from './server.mjs'

// Web side of the repo.ing AI credits sign-in handoff (src/repo-inference-handoff.mjs): the CLI's request rides in a sealed
// cookie through the GitHub sign-in to the consent page and its approval. Dark: every handoff route and the page answer 404
// unless both handoff secrets, the database and the GitHub App secret (which seals the cookie) are configured.
export const HANDOFF_COOKIE = 'repoing_handoff'
export const handoffAvailable = () => handoffEnabled() && Boolean(database()) && Boolean(process.env.GITHUB_APP_CLIENT_SECRET)
export const sealHandoffRequest = request => seal({ purpose: 'repo-inference-handoff', ...request, expiresAt: Date.now() + HANDOFF_REQUEST_SECONDS * 1000 })
export function readHandoffCookie(value) {
  const request = unseal(value)
  if (request?.purpose !== 'repo-inference-handoff') return null
  const { audience, repoId, challenge, port, state } = request
  return { audience, repoId, challenge, port, state }
}
export const noStore = response => {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}
