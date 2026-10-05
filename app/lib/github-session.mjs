import { createGitHubAppVerifier } from '../../src/github-verification.mjs'
import { database } from './server.mjs'
import { publicOrigin } from './origin.mjs'

export function sessionVerifier(session, requestUrl, { dashboard = false } = {}) {
  const verifier = createGitHubAppVerifier({ pool: database(), clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET, redirectUri: `${publicOrigin(requestUrl)}/api/github/callback` })
  return { async verifyCurrentAuthority({ githubRepoId }) {
    if (!session || (!dashboard && String(githubRepoId) !== session.repoId) || session.expiresAt <= Date.now()) throw new Error('GitHub session expired. Verify again.')
    const result = await verifier.verifyAccessToken({ githubRepoId, accessToken: session.accessToken, expectedGithubUserId: session.githubUserId })
    if (!result.verified || result.permission !== 'admin') throw new Error('Current GitHub admin permission required')
    return result
  },
  // A repository without a market (maintainer opt-outs): the same fresh admin check, recorded nowhere.
  async verifyRepositoryAdmin({ githubRepoId }) {
    if (!session || (!dashboard && String(githubRepoId) !== session.repoId) || session.expiresAt <= Date.now()) throw new Error('GitHub session expired. Verify again.')
    const result = await verifier.verifyRepositoryAdmin({ githubRepoId, accessToken: session.accessToken, expectedGithubUserId: session.githubUserId })
    if (!result.admin) throw new Error('Current GitHub admin permission required')
    return result
  },
  // The signed-in account as GitHub reports it now (contributor wallet links): the token still works, for the same user id.
  async currentIdentity() {
    if (!session || session.expiresAt <= Date.now()) throw new Error('GitHub session expired. Verify again.')
    return verifier.verifyIdentity({ accessToken: session.accessToken, expectedGithubUserId: session.githubUserId })
  },
  async listAdminRepositories() {
    if (!session || session.expiresAt <= Date.now()) throw new Error('GitHub session expired. Verify again.')
    return verifier.listAdminRepositories({ accessToken: session.accessToken, expectedGithubUserId: session.githubUserId })
  } }
}
