import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { clearFinalizedTransactionCache, forgetFinalizedTransaction, loadFinalizedTransaction, loadTransactionAt, normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { registerRpcEndpoint } from '../src/rpc-usage.mjs'
import { agreedFinalizedTransaction } from '../src/graduation-state.mjs'

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

test('finalized transactions are kept per endpoint; misses, confirmed reads and injected fetches always read', async () => {
  clearFinalizedTransactionCache()
  const raw = { ...transaction(0, [key(), key()]), blockTime: 1_700_000_000 }
  raw.transaction.message.instructions[0].programIdIndex = 1
  let result = null
  const calls = { a: 0, b: 0, injected: 0 }
  const rpc = name => async () => { calls[name]++; return { ok: true, status: 200, json: async () => ({ result }) } }
  registerRpcEndpoint('https://cache-a.invalid', rpc('a'))
  registerRpcEndpoint('https://cache-b.invalid', rpc('b'))
  const a = { rpcEndpoint: 'https://cache-a.invalid' }, b = { rpcEndpoint: 'https://cache-b.invalid' }
  assert.equal(await loadFinalizedTransaction(a, signature), null)
  result = raw
  const first = await loadFinalizedTransaction(a, signature)
  assert.equal(await loadFinalizedTransaction(a, signature), first)
  assert.equal(calls.a, 2, 'the miss was not kept; the found transaction was')
  await loadFinalizedTransaction(b, signature)
  assert.equal(calls.b, 1, 'each provider answers for itself')
  await loadTransactionAt(a, signature, 'confirmed')
  assert.equal(calls.a, 3, 'confirmed reads are never served from the cache')
  await loadFinalizedTransaction(a, signature, rpc('injected'))
  assert.equal(calls.injected, 1, 'an injected fetch always reads')
  clearFinalizedTransactionCache()
})

test('concurrent finalized reads share only the same provider; errors and null answers can be retried', async () => {
  clearFinalizedTransactionCache()
  const raw = { ...transaction(0, [key(), key()]), blockTime: 1700000000 }
  const calls = { a: 0, b: 0 }
  let outcome = new Error('unavailable')
  for (const name of ['a', 'b']) registerRpcEndpoint(`https://concurrent-${name}.invalid`, async () => {
    calls[name]++
    await new Promise(resolve => setImmediate(resolve))
    if (outcome instanceof Error) throw outcome
    return { ok: true, json: async () => ({ result: outcome }) }
  })
  const a = { rpcEndpoint: 'https://concurrent-a.invalid' }, b = { rpcEndpoint: 'https://concurrent-b.invalid' }
  const burst = () => Promise.allSettled(Array.from({ length: 12 }, () => loadFinalizedTransaction(a, signature)))
  assert.ok((await burst()).every(value => value.status === 'rejected'))
  assert.equal(calls.a, 1)
  outcome = null
  assert.ok((await burst()).every(value => value.value === null))
  outcome = raw
  const [values, other] = await Promise.all([burst(), loadFinalizedTransaction(b, signature)])
  assert.ok(values.every(value => value.value.blockTime === raw.blockTime))
  assert.equal(other.slot, 42)
  assert.deepEqual(calls, { a: 3, b: 1 })
  await Promise.all([loadTransactionAt(a, signature, 'confirmed'), loadTransactionAt(a, signature, 'confirmed')])
  assert.equal(calls.a, 5, 'confirmed reads are not coalesced')
  clearFinalizedTransactionCache()
})

test('invalidation during a finalized read prevents its late answer from refilling the cache', async () => {
  clearFinalizedTransactionCache()
  const connection = { rpcEndpoint: 'https://invalidation.invalid' }, releases = []
  const raw = { ...transaction(0, [key(), key()]), blockTime: 1700000000 }
  registerRpcEndpoint(connection.rpcEndpoint, () => new Promise(resolve => releases.push(blockTime =>
    resolve({ ok: true, json: async () => ({ result: { ...raw, blockTime } }) }))))
  const old = loadFinalizedTransaction(connection, signature)
  forgetFinalizedTransaction(connection, signature)
  const current = loadFinalizedTransaction(connection, signature)
  assert.equal(releases.length, 2, 'the new reader does not join the invalidated request')
  releases[1](1700000002); await current
  releases[0](1700000001); await old
  assert.equal((await loadFinalizedTransaction(connection, signature)).blockTime, 1700000002)
  clearFinalizedTransactionCache()
})

test('an answer without a block time is not kept, and a disagreement drops both providers\' kept answers', async () => {
  clearFinalizedTransactionCache()
  const raw = transaction(0, [key(), key()])
  raw.transaction.message.instructions[0].programIdIndex = 1
  const answers = { a: { ...raw, blockTime: null }, b: { ...raw, blockTime: 1_700_000_000 } }
  const calls = { a: 0, b: 0 }
  for (const name of ['a', 'b']) registerRpcEndpoint(`https://agree-${name}.invalid`, async () => {
    calls[name]++
    return { ok: true, status: 200, json: async () => ({ result: answers[name] }) }
  })
  const a = { rpcEndpoint: 'https://agree-a.invalid' }, b = { rpcEndpoint: 'https://agree-b.invalid' }
  await loadFinalizedTransaction(a, signature)
  await loadFinalizedTransaction(a, signature)
  assert.equal(calls.a, 2, 'no block time yet: read again next time')
  answers.a = { ...raw, blockTime: 1_699_999_999 }
  await assert.rejects(agreedFinalizedTransaction(a, b, signature), /RPC_DISAGREEMENT/)
  answers.a = { ...raw, blockTime: 1_700_000_000 }
  const agreed = await agreedFinalizedTransaction(a, b, signature)
  assert.equal(agreed.blockTime, 1_700_000_000, 'both sides were re-read after the disagreement')
  assert.deepEqual(calls, { a: 4, b: 2 })
  await agreedFinalizedTransaction(a, b, signature)
  assert.deepEqual(calls, { a: 4, b: 2 }, 'agreed answers are kept')
  clearFinalizedTransactionCache()
})
