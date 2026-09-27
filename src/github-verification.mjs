import { randomBytes, timingSafeEqual } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { markets, repoVerifications } from './db/schema.mjs'

const API = 'https://api.github.com'
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'repo.ing-repo-verification' }

const positiveId = value => {
  const id = BigInt(value)
  if (id <= 0n) throw new Error('GitHub ID must be positive')
  return id
}

export function createGitHubAppVerifier({ pool, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  if (!pool || !clientId || !clientSecret || !redirectUri) throw new Error('GitHub App OAuth and database configuration required')
  const db = drizzle(pool)
  const authorizationUrl = ({ githubRepoId } = {}) => {
    const repoId = githubRepoId === undefined ? null : positiveId(githubRepoId)
    const state = randomBytes(32).toString('hex')
    const url = new URL('https://github.com/login/oauth/authorize')
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state }).toString()
    return { url: url.toString(), state, githubRepoId: repoId }
  }
  const apiGet = async (path, token) => {
    const response = await fetchImpl(`${API}${path}`, { headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return { status: response.status, body: null }
    return { status: response.status, body: await response.json() }
  }
  const resolveRepo = async (repoId, token) => {
    const { status, body } = await apiGet(`/repositories/${repoId}`, token)
    if (status !== 200 || !body || !Number.isSafeInteger(body.id) || BigInt(body.id) !== repoId ||
        typeof body.owner?.login !== 'string' || typeof body.name !== 'string' ||
        body.private !== false || body.archived === true) {
      throw new Error('Current public GitHub repository identity could not be confirmed')
    }
    return { owner: body.owner.login, name: body.name }
  }
  const exchangeCode = async ({ code, state, expectedState }) => {
    if (typeof code !== 'string' || !code || typeof state !== 'string' || typeof expectedState !== 'string' ||
        !state || !expectedState || state.length !== expectedState.length ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
      throw new Error('GitHub OAuth callback state is invalid')
    }
    const exchanged = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        'User-Agent': GITHUB_HEADERS['User-Agent'] }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    })
    if (!exchanged.ok) throw new Error(`GitHub App authorization failed: HTTP ${exchanged.status}`)
    const credential = await exchanged.json()
    if (credential.token_type?.toLowerCase() !== 'bearer' || !credential.access_token?.startsWith('ghu_')) {
      throw new Error('GitHub did not return a GitHub App user access token')
    }
    return credential
  }
  const identify = async (token, expectedGithubUserId) => {
    if (typeof token !== 'string' || !token.startsWith('ghu_')) throw new Error('GitHub App user session required')
    const identity = await apiGet('/user', token)
    const user = identity.body
    if (identity.status !== 200 || !user || !Number.isSafeInteger(user.id) || user.id <= 0 ||
        typeof user.login !== 'string' || !user.login) throw new Error('Authenticated GitHub user could not be resolved')
    if (expectedGithubUserId !== undefined && BigInt(user.id) !== positiveId(expectedGithubUserId)) throw new Error('GitHub session identity changed')
    return user
  }
  const credentialResult = (credential, result) => ({ ...result, accessToken: credential.access_token,
    accessTokenExpiresAt: Date.now() + Math.min(3600, Number(credential.expires_in) > 0 ? Number(credential.expires_in) : 3600) * 1000 })
  const verifyBuilderCallback = async request => {
    const credential = await exchangeCode(request)
    const user = await identify(credential.access_token)
    // Identifying a dashboard user grants no repository authority.
    return credentialResult(credential, { scope: 'builders', githubRepoId: null,
      githubUserId: BigInt(user.id), githubLogin: user.login, permission: 'identity' })
  }
  const verifyCallback = async ({ githubRepoId, expectedGithubRepoId, retainCredential = false, ...request }) => {
    const repoId = positiveId(githubRepoId)
    if (repoId !== positiveId(expectedGithubRepoId)) throw new Error('GitHub OAuth repository ID is invalid')
    const credential = await exchangeCode(request)
    const result = await verifyAccessToken({ githubRepoId: repoId, accessToken: credential.access_token })
    // Return credentials only on explicit server-side opt-in; never include them in verification logs.
    if (!retainCredential || !result.verified) return result
    return credentialResult(credential, result)
  }
  const verifyAccessToken = async ({ githubRepoId, accessToken: token, expectedGithubUserId }) => {
    const repoId = positiveId(githubRepoId)
    if (typeof token !== 'string' || !token.startsWith('ghu_')) throw new Error('GitHub App user session required')
    const market = (await db.select().from(markets).where(eq(markets.githubRepoId, repoId)).limit(1))[0]
    if (!market || market.status !== 'confirmed' || market.indexedAt === null || market.launchFinality !== 'finalized') {
      throw new Error('Repository has no indexed canonical market')
    }
    const user = await identify(token, expectedGithubUserId)
    const repo = await resolveRepo(repoId, token)
    const permissionPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}` +
      `/collaborators/${encodeURIComponent(user.login)}/permission`
    const result = await apiGet(permissionPath, token)
    if (result.status !== 200 && result.status !== 404) {
      throw new Error(`GitHub permission check failed: HTTP ${result.status}`)
    }
    const permission = result.status === 404 ? 'none' : result.body?.permission ?? 'unknown'
    if (result.status === 200 && result.body?.user?.id !== user.id) {
      throw new Error('GitHub permission response is for a different user')
    }
    const after = await resolveRepo(repoId, token)
    if (after.owner !== repo.owner || after.name !== repo.name) {
      throw new Error('GitHub repository changed during permission verification')
    }
    if (permission !== 'admin') return { verified: false, githubRepoId: repoId,
      githubUserId: BigInt(user.id), githubLogin: user.login, permission }
    const [record] = await db.insert(repoVerifications).values({ githubRepoId: repoId,
      githubUserId: BigInt(user.id), githubLogin: user.login, permission }).returning()
    return { verified: true, githubRepoId: repoId, githubUserId: BigInt(user.id),
      githubLogin: user.login, permission, verifiedAt: record.verifiedAt }
  }
  const listAdminRepositoryIds = async ({ accessToken, expectedGithubUserId }) => {
    await identify(accessToken, expectedGithubUserId)
    const ids = new Set()
    // Paginate rather than silently omitting an owner's repositories after the first 100.
    for (let page = 1; page <= 100; page++) {
      const result = await apiGet(`/user/repos?visibility=public&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`, accessToken)
      if (result.status !== 200 || !Array.isArray(result.body)) throw new Error('GitHub repositories are temporarily unavailable. Try refreshing.')
      for (const repo of result.body) {
        if (Number.isSafeInteger(repo.id) && repo.id > 0 && repo.private === false && !repo.archived && repo.permissions?.admin === true) ids.add(String(repo.id))
      }
      if (result.body.length < 100) return [...ids]
    }
    throw new Error('GitHub returned too many repositories to check at once. Use the individual claim pages.')
  }
  return { authorizationUrl, verifyCallback, verifyBuilderCallback, verifyAccessToken, listAdminRepositoryIds }
}
