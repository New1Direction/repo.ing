import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import bs58 from 'bs58'
import { sign } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { DISCOVERY_CLAIM_MESSAGE_MS, MIN_DISCOVERY_CLAIM_LAMPORTS, SOLANA_MAINNET_GENESIS, discoveryClaimMessage,
  formatLamportsAsSol, isClaimId, verifyDiscoveryClaimSignature } from '../src/discovery-claim-message.mjs'

// Solana wallets sign messages with plain ed25519 over the raw bytes; tweetnacl-style detached signatures.
const signMessage = (keypair, message) => {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.subarray(0, 32))])
  return bs58.encode(sign(null, Buffer.from(message, 'utf8'), { key: pkcs8, format: 'der', type: 'pkcs8' }))
}
const launcher = Keypair.generate()
const terms = { repoId: '2002', market: 'octocat/reward-2002', wallet: launcher.publicKey.toBase58(), amount: 12_345_678n,
  claimId: '6f1c2b1e-8a4d-4c51-9d2f-0b6a3e5c7d90', genesis: SOLANA_MAINNET_GENESIS, expiresAt: new Date('2026-09-30T12:05:00Z') }

test('claim message is human readable and binds every payout term', () => {
  assert.equal(discoveryClaimMessage(terms), [
    'repo.ing wants you to confirm a launcher reward claim.',
    '',
    'Repository ID: 2002',
    'Market: octocat/reward-2002',
    `Wallet: ${terms.wallet}`,
    'Amount: 0.012345678 SOL (12345678 lamports)',
    'Claim: 6f1c2b1e-8a4d-4c51-9d2f-0b6a3e5c7d90',
    `Chain: Solana mainnet ${SOLANA_MAINNET_GENESIS}`,
    'Expires: 2026-09-30T12:05:00.000Z',
    '',
    'This does not authorize any transaction from your wallet.',
  ].join('\n'))
  assert.match(discoveryClaimMessage({ ...terms, genesis: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY' }), /Chain: Solana cluster 4uhc/)
  assert.equal(DISCOVERY_CLAIM_MESSAGE_MS, 300_000)
  assert.equal(MIN_DISCOVERY_CLAIM_LAMPORTS, 2_000_000n)
})

test('claim message rejects malformed terms', () => {
  for (const bad of [{ repoId: '0' }, { repoId: '1; drop' }, { market: 'a/b\nWallet: x' }, { market: 'nope' },
    { claimId: 'not-a-uuid' }, { amount: 0n }, { amount: -1n }, { genesis: 'bad!' }, { expiresAt: 'soon' }, { wallet: 'xyz' }]) {
    assert.throws(() => discoveryClaimMessage({ ...terms, ...bad }))
  }
})

test('lamports format exactly as SOL', () => {
  assert.equal(formatLamportsAsSol(0n), '0')
  assert.equal(formatLamportsAsSol(1n), '0.000000001')
  assert.equal(formatLamportsAsSol(2_500_000_000n), '2.5')
  assert.equal(formatLamportsAsSol('1000000000'), '1')
  assert.throws(() => formatLamportsAsSol(-1n))
})

test('only the launcher signature over the exact stored message verifies', () => {
  const message = discoveryClaimMessage(terms)
  const signature = signMessage(launcher, message)
  assert.equal(verifyDiscoveryClaimSignature({ message, signature, wallet: terms.wallet }), true)
  // Wrong wallet, tampered message (amount or wallet changed), or a signature by another key.
  const other = Keypair.generate()
  assert.equal(verifyDiscoveryClaimSignature({ message, signature, wallet: other.publicKey.toBase58() }), false)
  assert.equal(verifyDiscoveryClaimSignature({ message: message.replace('12345678 lamports', '99345678 lamports'), signature, wallet: terms.wallet }), false)
  assert.equal(verifyDiscoveryClaimSignature({ message, signature: signMessage(other, message), wallet: terms.wallet }), false)
  // Malformed input never throws.
  for (const bad of [undefined, '', 'x'.repeat(101), '0OIl', bs58.encode(Buffer.alloc(63)), bs58.encode(Buffer.alloc(64))]) {
    assert.equal(verifyDiscoveryClaimSignature({ message, signature: bad, wallet: terms.wallet }), false)
  }
  assert.equal(verifyDiscoveryClaimSignature({ message, signature, wallet: 'not a key' }), false)
  assert.equal(verifyDiscoveryClaimSignature({ message: null, signature, wallet: terms.wallet }), false)
})

test('claim ids are canonical lowercase UUIDs', () => {
  assert.equal(isClaimId(terms.claimId), true)
  for (const bad of [null, '', terms.claimId.toUpperCase(), `${terms.claimId} `, "x' or 1=1"]) assert.equal(isClaimId(bad), false)
})

test('the claim UI asks the wallet for a message signature, never a transaction', async () => {
  const source = await readFile('app/components/discovery-rewards.jsx', 'utf8')
  assert.match(source, /signMessage\(new TextEncoder\(\)\.encode\(prepared\.message\)\)/)
  assert.doesNotMatch(source, /signTransaction|signAllTransactions|signAndSendTransaction/)
})
