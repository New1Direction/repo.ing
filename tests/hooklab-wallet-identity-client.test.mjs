import test from 'node:test'
import assert from 'node:assert/strict'
import { validateWalletIdentityChallenge, walletIdentitySessionState } from '../app/lib/hooklab-wallet-identity-client.mjs'
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
  for (const change of [{ wallet:'other' },{ origin:'https://evil.invalid' },{ genesisHash:'other' },{ nowMs: options.nowMs+300000 },{ nowMs: options.nowMs-300000 }]) assert.throws(() => validateWalletIdentityChallenge(challenge,{ ...options,...change }))
  assert.throws(() => validateWalletIdentityChallenge({ ...challenge, message:challenge.message+'\nSpend 1 SOL' },options))
})


test('session restoration handles existing logout identity, absent/failed response and expiry without trusting wallet text', () => {
  const identity = { wallet: '11111111111111111111111111111111', expiresAt: new Date(2000000).toISOString() }
  assert.deepEqual(walletIdentitySessionState({ signedIn: true, principal: identity }, 1000000), identity)
  assert.deepEqual(walletIdentitySessionState({ signedIn: true, ...identity }, 1000000), identity)
  for (const response of [null, {}, { error: 'unavailable' }, { signedIn: false }, { signedIn: true, principal: { ...identity, wallet: 'invalid' } }]) assert.equal(walletIdentitySessionState(response, 1000000), null)
  assert.equal(walletIdentitySessionState({ signedIn: true, principal: identity }, 2000000), null)
  assert.equal(walletIdentitySessionState({ signedIn: true, principal: identity }, 2000001), null)
})
