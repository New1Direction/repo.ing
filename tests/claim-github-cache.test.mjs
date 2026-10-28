import test from 'node:test'
import assert from 'node:assert/strict'
import { cachedAppSettingsUrl, cachedInstallationStatus, clearClaimGithubCache, INSTALLED_TTL_MS, MISSING_TTL_MS } from '../app/lib/claim-github-cache.mjs'

test('an installed app is asked once per two minutes; a missing one again after 30 s; failures are never kept', async () => {
  clearClaimGithubCache()
  let t = 0, calls = 0, answer = { id: 7 }
  const opts = { now: () => t, check: async () => { calls++; if (answer instanceof Error) throw answer; return answer } }
  const repo = { owner: 'Owner', name: 'Repo' }
  assert.equal(await cachedInstallationStatus(repo, opts), 'installed')
  t = INSTALLED_TTL_MS - 1; assert.equal(await cachedInstallationStatus({ owner: 'owner', name: 'repo' }, opts), 'installed'); assert.equal(calls, 1)
  t = INSTALLED_TTL_MS + 1; answer = null; assert.equal(await cachedInstallationStatus(repo, opts), 'missing'); assert.equal(calls, 2)
  t += MISSING_TTL_MS - 1; await cachedInstallationStatus(repo, opts); assert.equal(calls, 2)
  t += 2; answer = Error('GitHub down'); await assert.rejects(cachedInstallationStatus(repo, opts)); assert.equal(calls, 3)
  answer = { id: 7 }; assert.equal(await cachedInstallationStatus(repo, opts), 'installed'); assert.equal(calls, 4, 'a failure is retried at once')
})

test('the app settings link is kept ten minutes per owner', async () => {
  clearClaimGithubCache()
  let calls = 0
  const opts = { now: () => 0, lookup: async ({ owner }) => { calls++; return `https://github.com/organizations/${owner}/settings/installations/1` } }
  await cachedAppSettingsUrl({ owner: 'Org' }, opts); await cachedAppSettingsUrl({ owner: 'org' }, opts)
  assert.equal(calls, 1)
})
