import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptGithubSession, readGithubSession, newGithubSession, seal, readClaimReview, assertSameOrigin } from '../app/lib/auth.mjs'
import { assertClaimSnapshot } from '../src/claim-review.mjs'
process.env.GITHUB_APP_CLIENT_SECRET = 'test-only-session-secret'
const session = () => newGithubSession({ githubRepoId: 123n, githubUserId: 42n, githubLogin: 'owner', permission: 'admin',
  accessToken: 'ghu_test_credential_never_public', accessTokenExpiresAt: Date.now() + 3600_000 })

test('credential is confidential, authenticated, short-lived, and invalidated by key rotation', () => {
  const payload = session(), encrypted = encryptGithubSession(payload)
  assert.deepEqual(readGithubSession(encrypted), payload)
  assert.ok(!encrypted.includes(payload.accessToken))
  assert.notEqual(encryptGithubSession(payload), encrypted)
  const parts = encrypted.split('.')
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
  assert.equal(readGithubSession(parts.join('.')), null)
  assert.equal(readGithubSession(encryptGithubSession({ ...payload, expiresAt: Date.now() - 1 })), null)
  assert.equal(readGithubSession(encryptGithubSession({ ...payload, expiresAt: 'bad' })), null)
  process.env.GITHUB_APP_CLIENT_SECRET = 'rotated-test-secret'
  assert.equal(readGithubSession(encrypted), null)
  process.env.GITHUB_APP_CLIENT_SECRET = 'test-only-session-secret'
})
test('claim reviews bind session, repository, expiry, recipient and cumulative paid revision', () => {
  const user = session()
  const review = { purpose: 'creator-claim-review', sessionId: user.sessionId, repoId: user.repoId, githubUserId: user.githubUserId,
    wallet: 'payout-wallet', boundAt: new Date().toISOString(), amount: '100', paid: '0', expiresAt: Date.now() + 60_000 }
  assert.deepEqual(readClaimReview(seal(review), user), review)
  for (const invalid of [null, session(), { ...user, repoId: '456' }, { ...user, githubUserId: '99' }]) assert.throws(() => readClaimReview(seal(review), invalid))
  assert.throws(() => readClaimReview(seal({ ...review, expiresAt: Date.now() - 1 }), user))
  const current = { repoId: 123n, beneficiary: { wallet: review.wallet, boundAt: new Date(review.boundAt) }, paid: '0' }
  assert.doesNotThrow(() => assertClaimSnapshot(review, current))
  assert.throws(() => assertClaimSnapshot(review, { ...current, paid: '100' }), /already used/)
  assert.throws(() => assertClaimSnapshot(review, { ...current, beneficiary: { ...current.beneficiary, wallet: 'other' } }))
})
test('cross-origin and missing-origin payout and binding requests are rejected', () => {
  const request = (origin, site = 'same-origin') => new Request('https://repo.ing/api/claim', { method: 'POST', headers: { ...(origin ? { origin } : {}), 'sec-fetch-site': site } })
  assert.doesNotThrow(() => assertSameOrigin(request('https://repo.ing'), 'https://repo.ing'))
  for (const r of [request('https://evil.test'), request(null), request('https://repo.ing', 'cross-site')]) assert.throws(() => assertSameOrigin(r, 'https://repo.ing'))
})
