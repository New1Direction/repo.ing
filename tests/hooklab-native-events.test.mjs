import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { productionHookEventDecoder } from '../src/hooklab-native-events.mjs'
import { indexHookNativeBatch } from '../src/hooklab-native-indexer.mjs'
import { nativeIndexFixture, key } from './fixtures/hooklab-native-index.mjs'

const decoder = productionHookEventDecoder(), swap = decoder.programs[1]
function receipt() {
  const authority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(swap))[0].toBase58()
  // Independently laid out ProtocolFeesCollected: pool, u64 quote_amount, collector, i64 ts.
  const body = Buffer.alloc(80)
  Buffer.alloc(32, 6).copy(body); body.writeBigUInt64LE(9007199254740993n, 32)
  Buffer.alloc(32, 7).copy(body, 40); body.writeBigInt64LE(-7n, 72)
  const data = Buffer.concat([Buffer.from('e445a52e51cb9a1da5227d9b0f5663bf', 'hex'), body])
  return { version: 0, transaction: { signatures: [bs58.encode(Buffer.alloc(64, 5))], message: {
    accountKeys: [key(2), swap], addressTableLookups: [{ accountKey: key(4), writableIndexes: [], readonlyIndexes: [0] }],
    instructions: [{ programIdIndex: 0, accounts: [], data: '' }],
  } }, meta: { err: null, fee: 5000, preBalances: [10000, 1, 1], postBalances: [5000, 1, 1],
    loadedAddresses: { writable: [], readonly: [authority] },
    innerInstructions: [{ index: 0, instructions: [
      { programIdIndex: 1, accounts: [], data: '', stackHeight: 2 },
      { programIdIndex: 1, accounts: [2], data: bs58.encode(data), stackHeight: 3 },
    ] }],
  } }
}

test('pinned production ABI decodes nested self-CPI/ALT and preserves exact raw integers without acceptance', () => {
  const raw = receipt(), out = decoder.decode(raw)
  assert.deepEqual(out.events, [{ program: swap, outerIndex: 0, innerIndex: 1, name: 'ProtocolFeesCollected',
    data: { pool: key(6), quote_amount: '9007199254740993', collector: key(7), ts: '-7' }, transactionFailed: false }])
  assert.equal(out.economicPostconditions, false); assert.equal(out.deploymentAdopted, false)
  raw.meta.err = { InstructionError: [0, 'Custom'] }
  assert.equal(decoder.decode(raw).events[0].transactionFailed, true)
  raw.meta.innerInstructions = []; raw.meta.logMessages = ['Program log: ProtocolFeesCollected']
  assert.deepEqual(decoder.decode(raw).events, [])
})

test('spoofed parent/authority, missing ancestry, unknown or trailing bytes cannot become decoded events', () => {
  for (const change of [
    r => { r.meta.innerInstructions[0].instructions[0].programIdIndex = 0 },
    r => { r.meta.innerInstructions[0].instructions[1].accounts = [0] },
    r => { delete r.meta.innerInstructions[0].instructions[0].stackHeight },
    r => { const i = r.meta.innerInstructions[0].instructions[1]; i.data = bs58.encode(Buffer.concat([bs58.decode(i.data), Buffer.from([0])])) },
    r => { const i = r.meta.innerInstructions[0].instructions[1], b = bs58.decode(i.data); b[8] ^= 1; i.data = bs58.encode(b) },
  ]) {
    const raw = receipt(); change(raw); assert.throws(() => decoder.decode(raw))
  }
})

test('decoder binding and malformed self-CPI stop the index checkpoint; valid receipts remain unadopted', async () => {
  const f = nativeIndexFixture()
  Object.assign(f.manifest, { sourceCommit: decoder.sourceCommit, idlSha256: decoder.idlSha256, programs: [swap] })
  f.blocks.get(100).transactions = [receipt()]
  let committed
  const store = { load: async () => ({ nextSlot: 100, lastBlock: null }), commit: async b => { committed = b } }
  await indexHookNativeBatch({ ...f, store, decoder })
  assert.equal(committed.rows.length, 1)
  assert.equal(committed.rows[0].receiptStatus, 'finalized-success')
  assert.equal(committed.rows[0].eventStatus, 'decoded-self-cpi')
  assert.equal(committed.rows[0].deploymentAdopted, false)
  committed = null
  f.blocks.get(100).transactions[0].meta.innerInstructions[0].instructions[1].accounts = [0]
  await assert.rejects(indexHookNativeBatch({ ...f, store, decoder }), /Unauthenticated/)
  assert.equal(committed, null)
  f.manifest.idlSha256 = '0'.repeat(64)
  await assert.rejects(indexHookNativeBatch({ ...f, store, decoder }), /binding differs/)
})
