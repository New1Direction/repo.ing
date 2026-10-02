import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { batchBindingMessage, createWalletBinding } from '../src/wallet-binding.mjs'

// Golden bytes of both GitHub wallet-binding messages. Wallets sign these exact UTF-8 bytes, so any change (including a
// refactor into pluggable authorities) breaks every challenge already issued and every wallet's signing prompt.
const WALLET = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw'
const NOW = Date.parse('2026-10-02T12:00:00.000Z'), EXPIRES = '2026-10-02T12:05:00.000Z'
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

// No database: drizzle's selects see one recent admin verification and no existing beneficiary; writes return nothing.
function fakePool() {
  const queries = []
  return { queries, async query(config, params) {
    const text = typeof config === 'string' ? config : config.text
    queries.push({ text, params })
    return { rows: /from "repo_verifications"/.test(text) ? [Array(16).fill(null)] : [], rowCount: 1 }
  } }
}

test('single binding message bytes are frozen', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW })
  try {
    const pool = fakePool()
    const challenge = await createWalletBinding({ pool }).requestChallenge({ githubRepoId: 1384142609n, githubUserId: 285551516n, wallet: WALLET })
    assert.match(challenge.nonce, /^[0-9a-f]{48}$/)
    assert.equal(challenge.expiresAt.toISOString(), EXPIRES)
    assert.equal(challenge.message, [
      'repo.ing repository beneficiary v1',
      'I bind this Solana wallet as beneficiary for the repository.',
      'Chain: Solana',
      'Repository ID: 1384142609',
      `Wallet: ${WALLET}`,
      `Nonce: ${challenge.nonce}`,
      `Expires: ${EXPIRES}`,
    ].join('\n'))
    assert.ok(pool.queries.some(query => /^insert into "wallet_binding_challenges"/.test(query.text) && query.params.includes(challenge.nonce)))
  } finally { mock.timers.reset() }
})

test('batch binding message bytes are frozen', () => {
  const at = new Date(EXPIRES)
  const message = batchBindingMessage([
    { githubRepoId: 1001n, githubUserId: 285551516n, wallet: WALLET, nonce: 'a'.repeat(48), expiresAt: at },
    { githubRepoId: 1002n, githubUserId: 285551516n, wallet: WALLET, nonce: 'b'.repeat(48), expiresAt: at.toISOString() },
  ])
  assert.equal(message, [
    'repo.ing repository beneficiaries v1',
    'I set this Solana wallet as the payout wallet for the repositories listed below.',
    'Chain: Solana',
    `Wallet: ${WALLET}`,
    'GitHub user ID: 285551516',
    `Repository ID: 1001 | Nonce: ${'a'.repeat(48)} | Expires: ${EXPIRES}`,
    `Repository ID: 1002 | Nonce: ${'b'.repeat(48)} | Expires: ${EXPIRES}`,
    'This signature sets payout wallets only. It does not send a transaction.',
  ].join('\n'))
  assert.equal(sha256(message), 'ac305ed4680366543555b5f6ace79b70d313a650ae6184fa54bd30a99941f1a3')
})

test('batch challenges are listed by ascending repository ID in the signed bytes', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW })
  try {
    const challenge = await createWalletBinding({ pool: fakePool() })
      .requestBatchChallenge({ githubRepoIds: ['1002', '1001'], githubUserId: '285551516', wallet: WALLET })
    const [first, second] = challenge.nonces
    assert.equal(challenge.message, [
      'repo.ing repository beneficiaries v1',
      'I set this Solana wallet as the payout wallet for the repositories listed below.',
      'Chain: Solana',
      `Wallet: ${WALLET}`,
      'GitHub user ID: 285551516',
      `Repository ID: 1001 | Nonce: ${first} | Expires: ${EXPIRES}`,
      `Repository ID: 1002 | Nonce: ${second} | Expires: ${EXPIRES}`,
      'This signature sets payout wallets only. It does not send a transaction.',
    ].join('\n'))
  } finally { mock.timers.reset() }
})
