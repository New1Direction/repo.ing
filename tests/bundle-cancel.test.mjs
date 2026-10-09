import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, Transaction } from '@solana/web3.js'
import { BUNDLE_VAULT_PROGRAM_ID, STATUS, bundleAddress, decodePlatform, platformAddress } from '../src/bundle-vault.mjs'
import { cancelBundleRaise } from '../src/bundle-cancel.mjs'
import { bundleData, fakeChain, platformData } from './fixtures/bundle-raise-fakes.mjs'

// scripts/cancel-bundle.mjs: the Bundle admin (the creator signer) cancels a raise that holds a repository it should not. A dry run
// only reads and simulates; --execute sends one cancel_bundle signed by the admin; a raise that launched is never touched.
const SOL = 1_000_000_000n
const CANCEL = createHash('sha256').update('global:cancel_bundle').digest().subarray(0, 8)
const admin = Keypair.generate(), opener = Keypair.generate()
const pool = { query: async () => ({ rows: [{ status: 'raising', fullName: 'owner/squatted' }] }) }

function setup(bundle = {}) {
  const chain = fakeChain(), simulated = []
  chain.setProgramAccount(platformAddress(), platformData({ admin: admin.publicKey }))
  chain.setProgramAccount(bundleAddress(7n), bundleData({ id: 7n, repoId: 42n, creator: opener.publicKey, target: 10n * SOL, raised: SOL,
    deadline: 1_900_000_000, ...bundle }))
  const simulate = chain.simulateTransaction
  chain.simulateTransaction = async tx => { simulated.push(tx); return simulate(tx) }
  chain.confirmTransaction = async () => ({ value: { err: null } })
  return { chain, simulated }
}

test('platform fixture reads back with its admin', () => {
  assert.ok(decodePlatform(platformData({ admin: admin.publicKey })).admin.equals(admin.publicKey))
})

test('dry run: reads the raise and simulates the signed cancel; nothing is sent', async () => {
  const { chain, simulated } = setup()
  const result = await cancelBundleRaise({ connection: chain, admin, pool, id: '7' })
  assert.deepEqual(result, { bundle: '7', repository: 'owner/squatted', siteStatus: 'raising', chainStatus: 'RAISING', raised: '1.0000 SOL',
    target: '10.0000 SOL', deadline: new Date(1_900_000_000_000).toISOString(), opener: opener.publicKey.toBase58(), cancellable: true,
    simulation: 'passed', broadcast: false, next: 'Run again with --execute to cancel. Backers can then refund; the worker frees the repository on its next pass.' })
  assert.equal(chain.sent.length, 0)
  const [tx] = simulated, ix = tx.instructions.at(-1)
  assert.ok(tx.feePayer.equals(admin.publicKey) && tx.verifySignatures())
  assert.ok(ix.programId.equals(BUNDLE_VAULT_PROGRAM_ID) && ix.data.equals(CANCEL))
  assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[admin.publicKey.toBase58(), true, false],
    [platformAddress().toBase58(), false, false], [bundleAddress(7n).toBase58(), false, true]])
})

test('--execute sends the one cancel and reports the raise failed on chain', async () => {
  const { chain } = setup()
  chain.onSend = raw => {
    assert.ok(Transaction.from(raw).instructions.at(-1).data.equals(CANCEL))
    chain.setProgramAccount(bundleAddress(7n), bundleData({ id: 7n, repoId: 42n, creator: opener.publicKey, status: STATUS.FAILED }))
  }
  const result = await cancelBundleRaise({ connection: chain, admin, pool, id: 7n, execute: true })
  assert.equal(chain.sent.length, 1)
  assert.deepEqual([result.cancelled, result.chainStatus, result.signature], [true, 'FAILED', 'sent'])
})

test('a launched or failed raise, the wrong admin, no admin or a refusal: nothing is sent', async () => {
  for (const bundle of [{ status: STATUS.LAUNCHED }, { status: STATUS.FAILED }, { released: SOL }]) {
    const { chain, simulated } = setup(bundle)
    const result = await cancelBundleRaise({ connection: chain, admin, pool, id: 7, execute: true })
    assert.deepEqual([result.cancellable, result.reason], [false, 'Only a raise that has not launched can be cancelled'], JSON.stringify(bundle, (k, v) => typeof v === 'bigint' ? String(v) : v))
    assert.deepEqual([simulated.length, chain.sent.length], [0, 0])
  }
  await assert.rejects(cancelBundleRaise({ connection: setup().chain, admin: Keypair.generate(), id: 7 }), /not the Bundle admin/)
  await assert.rejects(cancelBundleRaise({ connection: setup().chain, admin: null, id: 7 }), /PLATFORM_CREATOR_SECRET_KEY/)
  await assert.rejects(cancelBundleRaise({ connection: setup().chain, admin, id: '0' }), /positive whole number/)
  await assert.rejects(cancelBundleRaise({ connection: setup().chain, admin, id: 8 }), /No bundle 8/)
  const { chain } = setup()
  chain.simulation = { err: { InstructionError: [1, { Custom: 6000 }] }, logs: [] }
  const refused = await cancelBundleRaise({ connection: chain, admin, pool: null, id: 7, execute: true })
  assert.deepEqual([refused.cancellable, refused.repository, chain.sent.length], [false, 'GitHub repository 42', 0])
})
