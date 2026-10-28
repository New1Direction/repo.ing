// Unsigned collection plans: which pools, how much, and why the others wait.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planCollections, itemStillValid, DEFAULT_COLLECTION_POLICY } from '../src/hooklab-collection-plan.mjs'
import { collectInstruction } from '../src/hooklab-fee-collector.mjs'

const bundle = JSON.parse(readFileSync(new URL('../config/hooklab-stack-bundle.json', import.meta.url)))
const idl = JSON.parse(Buffer.from(bundle.profile.idls.swap, 'base64'))
const SWAP = '72tDzM3mhFsYU1qecrLpScv1Bud6XaszkQtB4YVjJh9s', TREASURY = 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i'
const CRANKER = '11111111111111111111111111111112'
const POOLS = ['7UsXD3oc5zYDgseRCyRUApHb4fAmmVPhKcBbQRMJuDv5', 'ARBeiTGidx2eGHmnqR5fA4B5t6L3TomYimvSc1oWKNXu', 'Fwy1111111111111111111111111111111111111111', 'Dup1111111111111111111111111111111111111111']
const NOW = Date.parse('2026-10-29T06:00:00Z')
const ledger = (pool, pending, over = {}) => ({ pool, mint: `mint-${pool.slice(0, 4)}`, reconciled: true, entries: [{ signature: `last-${pool.slice(0, 4)}` }],
  protocol: { pending, lastCollectionAt: null }, ...over })
const pools = Object.fromEntries(POOLS.map(p => [p, { feeModel: 2 }]))
const plan = (ledgers, extra = {}) => planCollections({ ledgers, pools, collector: TREASURY, now: NOW, ...extra })

test('pools at the threshold are planned largest first; the rest are skipped with their reason', () => {
  const result = plan([ledger(POOLS[0], 500_000n), ledger(POOLS[1], 9_000_000n), ledger(POOLS[2], 499_999n)])
  assert.equal(DEFAULT_COLLECTION_POLICY.thresholdLamports, 500_000n)
  assert.deepEqual(result.items.map(i => [i.pool, i.amount]), [[POOLS[1], 9_000_000n], [POOLS[0], 500_000n]])
  assert.deepEqual(result.skipped.map(s => [s.pool, s.reason]), [[POOLS[2], 'below-threshold']])
  assert.deepEqual({ ...result.totals }, { pools: 2, lamports: 9_500_000n, networkFeeLamports: 10_000n })
})

test('a market that does not reconcile, or was collected inside the cooldown, or is above the review cap, waits', () => {
  const result = plan([ledger(POOLS[0], 3_000_000n, { reconciled: false }),
    ledger(POOLS[1], 3_000_000n, { protocol: { pending: 3_000_000n, lastCollectionAt: new Date(NOW - 3600_000).toISOString() } }),
    ledger(POOLS[2], DEFAULT_COLLECTION_POLICY.reviewCapLamports + 1n),
    ledger(POOLS[3], 3_000_000n, { protocol: { pending: 3_000_000n, lastCollectionAt: new Date(NOW - 21 * 3600_000).toISOString() } })])
  assert.deepEqual(result.skipped.map(s => s.reason).sort(), ['cooldown', 'needs-review', 'unreconciled'])
  assert.deepEqual(result.items.map(i => i.pool), [POOLS[3]])
})

test('the network fee budget caps the pools per run, and only inclusive (fee model 2) pools can be collected natively', () => {
  const capped = plan([ledger(POOLS[0], 3_000_000n), ledger(POOLS[1], 4_000_000n)], { policy: { maxNetworkFeeLamports: 5000n } })
  assert.deepEqual([capped.items.map(i => i.pool), capped.skipped.map(s => s.reason)], [[POOLS[1]], ['network-fee-budget']])
  const legacy = planCollections({ ledgers: [ledger(POOLS[0], 3_000_000n)], pools: { [POOLS[0]]: { feeModel: 1 } }, collector: TREASURY, now: NOW })
  assert.deepEqual(legacy.skipped.map(s => s.reason), ['unsupported-fee-model'])
  assert.throws(() => plan([], { policy: { thresholdLamports: 10n, reviewCapLamports: 1n } }), /reviewCapLamports/)
  assert.throws(() => plan([], { policy: { thresholdLamports: 5 } }), /Invalid thresholdLamports/)
})

test('the same state gives the same plan id; any change in amount, history or collector gives another', () => {
  const ledgers = [ledger(POOLS[0], 3_000_000n), ledger(POOLS[1], 4_000_000n)]
  const id = plan(ledgers).id
  assert.equal(plan([...ledgers].reverse()).id, id)
  assert.notEqual(plan([ledger(POOLS[0], 3_000_001n), ledger(POOLS[1], 4_000_000n)]).id, id)
  assert.notEqual(plan([ledger(POOLS[0], 3_000_000n, { entries: [{ signature: 'newer' }] }), ledger(POOLS[1], 4_000_000n)]).id, id)
  assert.notEqual(planCollections({ ledgers, pools, collector: CRANKER, now: NOW }).id, id)
})

test('each item can carry its unsigned instruction: the IDL\'s collect_protocol_fees_native, paying only the planned collector', () => {
  const [item] = plan([ledger(POOLS[1], 4_000_000n)], { instructions: { swap: SWAP, idl, cranker: CRANKER } }).items
  const ix = collectInstruction({ swap: SWAP, pool: POOLS[1], collector: TREASURY, cranker: CRANKER, feeModel: 2, idl })
  assert.deepEqual(item.instruction, { programId: SWAP, data: Buffer.from(ix.data).toString('base64'),
    keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) })
  assert.deepEqual(item.instruction.keys.filter(k => k.isSigner).map(k => k.pubkey), [CRANKER], 'only the cranker signs')
  assert.deepEqual(item.instruction.keys.filter(k => k.isWritable).map(k => k.pubkey), [POOLS[1], TREASURY])
})

test('an executor sends an item only while the pool still holds exactly the planned amount for the planned collector', () => {
  const result = plan([ledger(POOLS[1], 4_000_000n)]), [item] = result.items
  assert.equal(itemStillValid(item, { protocolFeesQuote: 4_000_000n, collector: TREASURY }, result), true)
  assert.equal(itemStillValid(item, { protocolFeesQuote: 4_000_001n, collector: TREASURY }, result), false)
  assert.equal(itemStillValid(item, { protocolFeesQuote: 0n, collector: TREASURY }, result), false, 'already collected')
  assert.equal(itemStillValid(item, { protocolFeesQuote: 4_000_000n, collector: CRANKER }, result), false)
})
