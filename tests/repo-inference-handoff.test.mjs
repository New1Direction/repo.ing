import test from 'node:test'
import assert from 'node:assert/strict'
import { HANDOFF_AUDIENCE, HandoffError, assertionMessage, callbackUrl, clientAuthorized, handoffCheckCode, handoffSettings, readHandoffRequest,
  signAssertion } from '../src/repo-inference-handoff.mjs'
import { checkCode } from '../cli/src/claim.mjs'

// The repo.ing AI credits sign-in handoff (src/repo-inference-handoff.mjs): request parsing, the loopback callback, the
// signed assertion (the same vector is checked by the credit ledger, repo-inference src/conversion.rs) and the settings.
const request = { audience: 'repo-inference', repo: '1296269', challenge: 'c'.repeat(43), port: '54321', state: 's'.repeat(22) }

test('a handoff request names the audience, a GitHub repository, an S256 challenge, a loopback port and a state', () => {
  assert.deepEqual(readHandoffRequest(new URLSearchParams(request)), { audience: HANDOFF_AUDIENCE, repoId: '1296269', challenge: 'c'.repeat(43), port: 54321, state: 's'.repeat(22) })
  for (const [field, value] of [['audience', 'other'], ['repo', '0'], ['repo', '4503599627370496'], ['repo', 'abc'], ['challenge', 'c'.repeat(42)],
    ['challenge', `${'c'.repeat(42)}=`], ['port', '80'], ['port', '70000'], ['port', '5432.0'], ['state', 'short'], ['state', 's'.repeat(20) + '+/']]) {
    assert.throws(() => readHandoffRequest(new URLSearchParams({ ...request, [field]: value })), HandoffError, `${field}=${value}`)
  }
})

test('the browser goes back only to the loopback address, with the code or the refusal and the state', () => {
  const parsed = readHandoffRequest(new URLSearchParams(request))
  assert.equal(callbackUrl(parsed, { code: 'x'.repeat(43) }), `http://127.0.0.1:54321/callback?code=${'x'.repeat(43)}&state=${'s'.repeat(22)}`)
  assert.equal(callbackUrl(parsed, { error: 'not_admin' }), `http://127.0.0.1:54321/callback?error=not_admin&state=${'s'.repeat(22)}`)
  assert.equal(callbackUrl(parsed, {}), `http://127.0.0.1:54321/callback?error=access_denied&state=${'s'.repeat(22)}`)
})

test('the assertion: the canonical text and its HMAC, as the credit ledger checks them', () => {
  const facts = { handoffId: 'AbCdEfGhIjKlMnOpQrStUvWx', githubUserId: '583231', login: 'octocat', repoId: '1296269', permission: 'admin', verifiedAt: '2026-10-07T19:00:00.000Z' }
  assert.equal(assertionMessage(facts), 'repoing-handoff-v1\nrepo-inference\nAbCdEfGhIjKlMnOpQrStUvWx\n583231\noctocat\n1296269\nadmin\n2026-10-07T19:00:00.000Z')
  assert.equal(signAssertion('handoff-assertion-vector-secret-0123456789', facts), '5d2b2550ac3647200189d4f65ea200c87f187f83c618e46ce4bf74405a471ec1')
})

test('the check code the page shows is the one the CLI prints for the same challenge', () => {
  assert.equal(handoffCheckCode('c'.repeat(43)), checkCode('c'.repeat(43)))
  assert.match(handoffCheckCode('c'.repeat(43)), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
  assert.notEqual(handoffCheckCode('c'.repeat(43)), handoffCheckCode('d'.repeat(43)))
})

test('settings: both secrets, 32 to 256 characters, different from each other and from the GitHub App secret', () => {
  const env = { REPO_INFERENCE_HANDOFF_SECRET: 'a'.repeat(32), HANDOFF_ASSERTION_SECRET: 'b'.repeat(32), GITHUB_APP_CLIENT_SECRET: 'c'.repeat(40) }
  assert.deepEqual(handoffSettings(env), { clientSecret: 'a'.repeat(32), assertionSecret: 'b'.repeat(32) })
  for (const bad of [{ REPO_INFERENCE_HANDOFF_SECRET: undefined }, { HANDOFF_ASSERTION_SECRET: 'short' }, { HANDOFF_ASSERTION_SECRET: 'a'.repeat(32) },
    { GITHUB_APP_CLIENT_SECRET: 'a'.repeat(32) }, { REPO_INFERENCE_HANDOFF_SECRET: 'a'.repeat(257) }]) {
    assert.equal(handoffSettings({ ...env, ...bad }), null, JSON.stringify(bad))
  }
  const settings = handoffSettings(env)
  assert.equal(clientAuthorized(`Bearer ${'a'.repeat(32)}`, settings), true)
  for (const header of [`Bearer ${'b'.repeat(32)}`, `bearer ${'a'.repeat(32)}`, 'a'.repeat(32), null, undefined, `Bearer ${'a'.repeat(31)}`]) {
    assert.equal(clientAuthorized(header, settings), false, String(header))
  }
})
