import test from 'node:test'
import assert from 'node:assert/strict'
import { CLOCK_SKEW_MS, validateWalletIdentityChallenge, walletIdentitySessionState } from '../app/lib/hooklab-wallet-identity-client.mjs'
const options = { wallet: 'wallet-fixture', origin: 'https://repo.ing', genesisHash: 'genesis-fixture', nowMs: 1000000 }
const nonce = 'a'.repeat(64), expiresAt = new Date(options.nowMs+299000).toISOString()
const challenge = { wallet: options.wallet, nonce, expiresAt, message: [
  'repo.ing general launcher wallet identity v1', `Origin: ${options.origin}`, 'Audience: general-launcher',
  `Genesis: ${options.genesisHash}`, `Wallet: ${options.wallet}`, `Browser binding SHA256: ${'b'.repeat(64)}`,
  `Nonce: ${nonce}`, `Expires: ${expiresAt}`,
  'Sign in to this launcher only. No spending, transaction, creator grant or launch authorization.',
].join('\n') }
test('identity UI accepts only exact reviewed identity-only challenge and refuses changed wallet, scope, time or spending request', () => {
  assert.equal(validateWalletIdentityChallenge(challenge, options), challenge)
  for (let i=0;i<9;i++) {
    const lines=challenge.message.split('\n');lines[i]+=' changed'
    assert.throws(() => validateWalletIdentityChallenge({ ...challenge, message: lines.join('\n') }, options))
  }
  for (const change of [{ wallet:'other' },{ origin:'https://evil.invalid' },{ genesisHash:'other' },{ nowMs: options.nowMs+299000+CLOCK_SKEW_MS },{ nowMs: options.nowMs-CLOCK_SKEW_MS-2000 }]) assert.throws(() => validateWalletIdentityChallenge(challenge,{ ...options,...change }))
  assert.throws(() => validateWalletIdentityChallenge({ ...challenge, message:challenge.message+'\nSpend 1 SOL' },options))
})


// The server sets expiry with its own clock: 5 minutes after it issued the challenge.
const issued = serverNowMs => {
  const expiresAt = new Date(serverNowMs + 300000).toISOString(), lines = challenge.message.split('\n')
  lines[7] = `Expires: ${expiresAt}`
  return { ...challenge, expiresAt, message: lines.join('\n') }
}
test('ordinary clock differences between the browser and the server do not block sign-in', () => {
  // Live 2026-10-19: the challenge expired 300,051 ms after the browser's clock, so sign-in stopped before the wallet prompt.
  for (const browserOffsetMs of [-51, -1, 0, 2000, -120000, 120000, -9 * 60000, 9 * 60000])
    assert.doesNotThrow(() => validateWalletIdentityChallenge(issued(options.nowMs), { ...options, nowMs: options.nowMs + browserOffsetMs }), `browser clock ${browserOffsetMs} ms`)
  for (const browserOffsetMs of [-CLOCK_SKEW_MS - 1000, 300000 + CLOCK_SKEW_MS])
    assert.throws(() => validateWalletIdentityChallenge(issued(options.nowMs), { ...options, nowMs: options.nowMs + browserOffsetMs }), `browser clock ${browserOffsetMs} ms`)
})

test('session restoration handles existing logout identity, absent/failed response and expiry without trusting wallet text', () => {
  const identity = { wallet: '11111111111111111111111111111111', expiresAt: new Date(2000000).toISOString() }
  assert.deepEqual(walletIdentitySessionState({ signedIn: true, principal: identity }, 1000000), identity)
  assert.deepEqual(walletIdentitySessionState({ signedIn: true, ...identity }, 1000000), identity)
  for (const response of [null, {}, { error: 'unavailable' }, { signedIn: false }, { signedIn: true, principal: { ...identity, wallet: 'invalid' } }]) assert.equal(walletIdentitySessionState(response, 1000000), null)
  assert.equal(walletIdentitySessionState({ signedIn: true, principal: identity }, 2000000), null)
  assert.equal(walletIdentitySessionState({ signedIn: true, principal: identity }, 2000001), null)
})
