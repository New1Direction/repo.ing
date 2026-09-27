import { createSign } from 'node:crypto'

let cachedToken = null
let pendingToken = null

function appJwt(privateKey, clientId) {
  const now = Math.floor(Date.now() / 1000)
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: clientId })}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`
}

function appIdentity() {
  const encodedKey = process.env.GITHUB_APP_PRIVATE_KEY_BASE64
  const clientId = process.env.GITHUB_APP_CLIENT_ID
  if (!encodedKey || !clientId) throw new Error('GitHub App API authentication is not configured')
  return { privateKey: Buffer.from(encodedKey, 'base64').toString('utf8'), clientId }
}

const appHeaders = (identity, userAgent) => ({
  Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': userAgent, Authorization: `Bearer ${appJwt(identity.privateKey, identity.clientId)}`,
})

export async function githubInstallationForRepository({ owner, name, fetchImpl = fetch, identity = appIdentity() }) {
  const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`, {
    headers: appHeaders(identity, 'repo.ing-claim-access'), cache: 'no-store', signal: AbortSignal.timeout(5000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub App repository access check failed: HTTP ${response.status}`)
  const installation = await response.json()
  if (!Number.isSafeInteger(installation.id) || installation.id <= 0) throw new Error('Invalid GitHub App installation')
  return { id: installation.id }
}

export async function githubAppConfigurationUrl({ owner, fetchImpl = fetch, identity = appIdentity() }) {
  const fallback = 'https://github.com/apps/repo-ing/installations/new'
  for (const kind of ['users', 'orgs']) {
    const response = await fetchImpl(`https://api.github.com/${kind}/${encodeURIComponent(owner)}/installation`, {
      headers: appHeaders(identity, 'repo.ing-claim-access'), cache: 'no-store', signal: AbortSignal.timeout(5000),
    })
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`GitHub App account access check failed: HTTP ${response.status}`)
    const url = (await response.json()).html_url
    return typeof url === 'string' && url.startsWith('https://github.com/') ? url : fallback
  }
  return fallback
}

export async function currentGithubAdminForRepository({ repoId, owner, name, githubUserId, githubLogin,
  fetchImpl = fetch, identity = appIdentity() }) {
  const numericRepoId = Number(repoId)
  if (!Number.isSafeInteger(numericRepoId) || numericRepoId <= 0) throw new Error('Invalid GitHub repository ID')
  const installation = await githubInstallationForRepository({ owner, name, fetchImpl, identity })
  if (!installation) return false
  const tokenResponse = await fetchImpl(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
    method: 'POST', headers: { ...appHeaders(identity, 'repo.ing-binding-check'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository_ids: [numericRepoId] }), cache: 'no-store', signal: AbortSignal.timeout(5000),
  })
  if (!tokenResponse.ok) throw new Error(`GitHub App repository token failed: HTTP ${tokenResponse.status}`)
  const token = (await tokenResponse.json()).token
  if (typeof token !== 'string' || !token.startsWith('ghs_')) throw new Error('Invalid GitHub App repository token')
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'repo.ing-binding-check', Authorization: `Bearer ${token}` }
  const repoResponse = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    headers, cache: 'no-store', signal: AbortSignal.timeout(5000),
  })
  if (!repoResponse.ok || String((await repoResponse.json()).id) !== String(repoId)) return false
  const permissionResponse = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/collaborators/${encodeURIComponent(githubLogin)}/permission`, {
    headers, cache: 'no-store', signal: AbortSignal.timeout(5000),
  })
  if (permissionResponse.status === 404) return false
  if (!permissionResponse.ok) throw new Error(`GitHub admin permission check failed: HTTP ${permissionResponse.status}`)
  const permission = await permissionResponse.json()
  return permission.permission === 'admin' && String(permission.user?.id) === String(githubUserId)
}

async function installationToken(fetchImpl) {
  const encodedKey = process.env.GITHUB_APP_PRIVATE_KEY_BASE64
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID
  if (!encodedKey && !installationId) {
    if (process.env.NODE_ENV === 'production') throw new Error('GitHub App API authentication is not configured')
    return null
  }
  if (!encodedKey || !/^\d+$/.test(installationId || '') || !process.env.GITHUB_APP_CLIENT_ID) {
    throw new Error('GitHub App API authentication is incomplete')
  }
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) return cachedToken.value
  if (!pendingToken) {
    pendingToken = (async () => {
      const key = Buffer.from(encodedKey, 'base64').toString('utf8')
      const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: 'POST', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'repo.ing', Authorization: `Bearer ${appJwt(key, process.env.GITHUB_APP_CLIENT_ID)}` },
      })
      if (!response.ok) throw new Error(`GitHub App token request failed: HTTP ${response.status}`)
      const token = await response.json()
      const expiresAt = Date.parse(token.expires_at)
      if (typeof token.token !== 'string' || !Number.isFinite(expiresAt)) throw new Error('GitHub App returned an invalid token')
      cachedToken = { value: token.token, expiresAt }
      return token.token
    })().finally(() => { pendingToken = null })
  }
  return pendingToken
}

export async function githubApiHeaders(userAgent, fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent }
  const token = await installationToken(fetchImpl)
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}
