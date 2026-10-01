import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { loadFinalizedTransaction, normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'

const key = () => Keypair.generate().publicKey.toBase58()
const signature = 'test-finalized-signature'

function transaction(version, staticKeys, loaded = { writable: [], readonly: [] }) {
  return { version, slot: 42, transaction: { signatures: [signature], message: {
    accountKeys: staticKeys, instructions: [{ programIdIndex: staticKeys.length, accounts: [0], data: '2' }],
  } }, meta: { err: null, loadedAddresses: loaded, innerInstructions: [] } }
}

test('v0 loaded addresses resolve after static keys for canonical instruction checks', () => {
  const [payer, program] = [key(), key()]
  const normalized = normalizeFinalizedTransaction(transaction(0, [payer], { writable: [program], readonly: [] }), signature)
  const keys = normalized.transaction.message.accountKeys
  assert.equal(keys[0].toBase58(), payer)
  assert.equal(keys[normalized.transaction.message.instructions[0].programIdIndex].toBase58(), program)
})

test('v1 JSON transaction is accepted without web3.js message deserialization', async () => {
  const [payer, program] = [key(), key()]
  const raw = transaction(1, [payer, program])
  raw.transaction.message.instructions[0].programIdIndex = 1
  raw.transaction.message.transactionConfig = { computeUnitLimit: 30_000 }
  let request
  const normalized = await loadFinalizedTransaction({ rpcEndpoint: 'https://example.invalid' }, signature,
    async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ result: raw }) } })
  assert.equal(request.params[1].maxSupportedTransactionVersion, 1)
  assert.equal(request.params[1].encoding, 'json')
  assert.equal(normalized.transaction.message.accountKeys[1].toBase58(), program)
})

test('wrong signature and unsupported versions fail closed', () => {
  const raw = transaction(1, [key(), key()])
  assert.throws(() => normalizeFinalizedTransaction(raw, 'different-signature'), /unsupported or incomplete/)
  assert.throws(() => normalizeFinalizedTransaction({ ...raw, version: 2 }, signature), /unsupported or incomplete/)
})

test('HTTP 429 is retried with backoff, then fails closed if it persists', async () => {
  const ok = { ok: true, status: 200, headers: new Headers(), json: async () => ({ result: null }) }
  const limited = { ok: false, status: 429, headers: new Headers(), json: async () => ({}) }
  let calls = 0
  const flaky = async () => (++calls < 3 ? limited : ok)
  assert.equal(await loadFinalizedTransaction({ rpcEndpoint: 'https://example.invalid' }, 'sig', flaky, [1, 1, 1]), null)
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(loadFinalizedTransaction({ rpcEndpoint: 'https://example.invalid' }, 'sig', async () => { calls++; return limited }, [1, 1]), /HTTP 429/)
  assert.equal(calls, 3)
})
