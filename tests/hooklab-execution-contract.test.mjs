import test from 'node:test'
import assert from 'node:assert/strict'
import { hookExecutionIntentSchema, HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { GET, POST } from '../app/api/hook-lab/production/route.js'
import { createHookIndexRpc, indexHookNativeBatch } from '../src/hooklab-native-indexer.mjs'
import { key, nativeIndexFixture } from './fixtures/hooklab-native-index.mjs'

test('public contract accepts only separately bound plain/trade intent shapes; never enables execution', async () => {
  const intent = { schema: 'repoing/hook-execution-intent/1', id: '00000000-0000-4000-8000-000000000001',
    operation: 'create-plain', expectedContext: { genesisHash: HOOK_MAINNET_GENESIS, profileSha256: 'a'.repeat(64),
      policySha256: 'b'.repeat(64), quoteMint: key(5), quoteDecimals: 9 }, wallet: key(2), mint: key(3), feePayer: key(4),
    maxNetworkFeeLamports: '5000', maxTotalDebitLamports: '100000', maxRentLamports: '90000', maxProgramFeeLamports: '5000',
    virtualQuoteRaw: '1000000000', recipe: { schemaVersion: 'repo-ing/hook-lab-recipe/1',
      recipe: { format: 'hook-lab/1', coin: { name: 'Test', ticker: 'TEST' }, blocks: [] } } }
  assert.deepEqual(hookExecutionIntentSchema.parse(intent), intent)
  for (const mutate of [i => { i.recipe.recipe.blocks = [{ type: 'creator_fee', fee_bps: 0 }] },
    i => { i.schema = 'repoing-playground/1' }, i => { i.schema = 'repoing-playground-draft/1' },
    i => { i.ready = true }, i => { i.operation = 'create-custom' }, i => { i.maxTotalDebitLamports = 100000 },
    i => { i.virtualQuoteRaw = '18446744073709551616' }, i => { i.expectedContext.genesisHash = key(6) },
    i => { i.recipe.recipe.coin.supply = '0' }, i => { i.recipe.template = 'plain' }]) {
    const changed = structuredClone(intent); mutate(changed)
    assert.equal(hookExecutionIntentSchema.safeParse(changed).success, false)
  }
  const response = GET(), body = await response.json()
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(body.contract.activeProfile, null)
  assert.equal(body.contract.plainIsCustomHook, false)
  assert.ok(Object.values(body.contract.capabilities).every(v => v === false))
  assert.equal(POST({ get body() { throw Error('Must not consume input') } }).status, 423)
})

test('indexer discovers native CPI through lookup keys, retains failed receipts and skips non-invocations', async () => {
  const f = nativeIndexFixture(), batches = []
  let state = { nextSlot: 100, lastBlock: null }
  const store = { load: async () => state, commit: async b => { batches.push(b); state = b } }
  assert.deepEqual(await indexHookNativeBatch({ ...f, store }), { status: 'indexed-raw', nextSlot: 103, transactions: 2, executionEnabled: false })
  const batch = batches[0]
  assert.deepEqual(batch.blocks.map(b => [b.slot, b.blockhash]), [[100, key(10)], [101, null], [102, key(12)]])
  assert.deepEqual(batch.rows.map(r => [r.slot, r.transactionIndex, r.receiptStatus]), [[100, 0, 'finalized-success'], [102, 0, 'finalized-failure']])
  assert.ok(batch.rows.every(r => r.eventStatus === 'undecoded' && !r.economicPostconditions && !r.deploymentAdopted))
  assert.equal((await indexHookNativeBatch({ ...f, store })).status, 'caught-up')
  assert.equal(batches.length, 1)
})

test('missing, pruned, malformed or conflicting evidence never advances an index checkpoint', async () => {
  for (const change of [
    (m, value) => m === 'getGenesisHash' ? key(9) : value,
    (m, value) => m === 'getFirstAvailableBlock' ? 101 : value,
    (m, value) => m === 'getBlocks' ? [100] : value,
    (m, value) => m === 'getBlock' ? null : value,
    (m, value) => { if (m === 'getBlock') value.transactions[0].meta.fee++; return value },
  ]) {
    const f = nativeIndexFixture(), original = f.adapters[1].read
    f.adapters[1].read = async (...args) => change(args[0], await original(...args))
    let writes = 0
    await assert.rejects(indexHookNativeBatch({ ...f, store: { load: async () => ({ nextSlot: 100, lastBlock: null }), commit: async () => { writes++ } } }))
    assert.equal(writes, 0)
  }
  for (const mutate of [f => { f.blocks.get(102).parentSlot = 101 },
    f => { f.blocks.get(100).transactions[0].meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1 },
    f => { f.blocks.get(100).transactions[0].meta.loadedAddresses = null }]) {
    const f = nativeIndexFixture(); mutate(f)
    await assert.rejects(indexHookNativeBatch({ ...f, store: { load: async () => ({ nextSlot: 100, lastBlock: null }), commit: () => assert.fail('must not write') } }))
  }
})

test('RPC adapter forbids signing/sending/simulation and redacts transport errors', async () => {
  let requests = 0
  const read = createHookIndexRpc('https://rpc.invalid/private-token', async () => { requests++; throw Error('private-token') })
  for (const method of ['sendTransaction', 'sendRawTransaction', 'simulateTransaction', 'requestAirdrop']) await assert.rejects(read(method), /forbidden/)
  assert.equal(requests, 0)
  await assert.rejects(read('getSlot'), { message: 'Hook index RPC unavailable' })
  assert.throws(() => createHookIndexRpc('http://rpc.invalid'), /HTTPS/)
})
