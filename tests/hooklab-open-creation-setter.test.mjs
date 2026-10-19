// The owner's open-creation switch against the program's own oracle vectors (hook-lab feat/open-creation 36dd07e,
// production vectors): the governed_set_open_creation data and the recorded policy-change digests. No RPC; no keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { governedSetOpenCreation, openCreationDigest } from '../src/hooklab-open-creation.mjs'

const vectors = JSON.parse(readFileSync(new URL('../vendor/hooklab-native-candidate/open-36dd07e/open-creation-vectors.production.json', import.meta.url)))
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const LAUNCH = 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft'
const OWNER = { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }

test('governed_set_open_creation data is the program\'s exact bytes', () => {
  const ix = governedSetOpenCreation({ launchProgram: LAUNCH, admin: key(21), expected: Buffer.alloc(32, 12), on: true, ...OWNER })
  assert.equal(ix.data.toString('hex'), vectors.governed_set_open_creation_data)
  assert.equal(ix.data.subarray(0, 8).toString('hex'), vectors.governed_set_open_creation_discriminator)
  assert.deepEqual(ix.keys.map(k => [k.isSigner, k.isWritable]), [[true, false], [false, true], [false, true], [false, false], [false, false]])
  assert.equal(ix.programId.toBase58(), LAUNCH)
})

test('the recorded open-creation digest matches the program for on and off with the owner menus', () => {
  assert.equal(openCreationDigest(LAUNCH, key(9), { on: true, ...OWNER }).toString('hex'), vectors.open_creation_on1_owner_digest)
  assert.equal(openCreationDigest(LAUNCH, key(9), { on: false, ...OWNER }).toString('hex'), vectors.open_creation_on0_owner_digest)
  assert.equal(openCreationDigest(LAUNCH, key(9), { on: false, creatorFeeBps: [], capBps: [] }).toString('hex'), vectors.open_creation_on0_empty_digest)
})

test('the setter refuses a malformed commitment, switch or menu before encoding', () => {
  const base = { launchProgram: LAUNCH, admin: key(21), expected: Buffer.alloc(32, 12), on: true, ...OWNER }
  assert.throws(() => governedSetOpenCreation({ ...base, expected: Buffer.alloc(31) }), /32-byte commitment/)
  assert.throws(() => governedSetOpenCreation({ ...base, on: 1 }), /on or off/)
  assert.throws(() => governedSetOpenCreation({ ...base, capBps: [1, 2, 3, 4, 5] }), /at most 4/)
})
