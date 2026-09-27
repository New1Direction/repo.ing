import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { currentGithubAdminForRepository, githubAppConfigurationUrl, githubInstallationForRepository } from '../src/github-app-auth.mjs'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const identity = { clientId: 'Iv23test', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const args = { repoId: '1269625283', owner: 'New1Direction', name: 'ohiyo',
  githubUserId: '285551516', githubLogin: 'New1Direction', identity }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('missing repository installation stops verification before requesting a token', async () => {
  const calls = []
  const fetchImpl = async url => { calls.push(url); return json({ message: 'Not Found' }, 404) }
  assert.equal(await githubInstallationForRepository({ ...args, fetchImpl }), null)
  assert.equal(await currentGithubAdminForRepository({ ...args, fetchImpl }), false)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(url => url.endsWith('/repos/New1Direction/ohiyo/installation')))
})

test('current admin check scopes its installation token to the canonical repository', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/installation')) return json({ id: 164573996 })
    if (url.endsWith('/access_tokens')) return json({ token: 'ghs_test' })
    if (url.endsWith('/permission')) return json({ permission: 'admin', user: { id: 285551516 } })
    return json({ id: 1269625283 })
  }
  assert.equal(await currentGithubAdminForRepository({ ...args, fetchImpl }), true)
  assert.deepEqual(JSON.parse(calls[1].options.body), { repository_ids: [1269625283] })
  assert.equal(calls[1].options.method, 'POST')
  assert.ok(calls[2].options.headers.Authorization.startsWith('Bearer ghs_'))
})

test('binding rejects another repository, user, or permission', async () => {
  for (const [repoId, userId, permission] of [
    [7, 285551516, 'admin'], [1269625283, 999, 'admin'], [1269625283, 285551516, 'write'],
  ]) {
    const fetchImpl = async url => {
      if (url.endsWith('/installation')) return json({ id: 164573996 })
      if (url.endsWith('/access_tokens')) return json({ token: 'ghs_test' })
      if (url.endsWith('/permission')) return json({ permission, user: { id: userId } })
      return json({ id: repoId })
    }
    assert.equal(await currentGithubAdminForRepository({ ...args, fetchImpl }), false)
  }
})

test('GitHub access errors fail closed instead of appearing as a missing installation', async () => {
  await assert.rejects(githubInstallationForRepository({ ...args,
    fetchImpl: async () => json({ message: 'Unavailable' }, 503) }), /HTTP 503/)
})

test('claim guidance links to an existing installation, with a safe install fallback', async () => {
  const settings = 'https://github.com/settings/installations/164573996'
  assert.equal(await githubAppConfigurationUrl({ owner: 'New1Direction', identity,
    fetchImpl: async () => json({ html_url: settings }) }), settings)
  assert.equal(await githubAppConfigurationUrl({ owner: 'New1Direction', identity,
    fetchImpl: async () => json({ message: 'Not Found' }, 404) }),
  'https://github.com/apps/repo-ing/installations/new')
})
