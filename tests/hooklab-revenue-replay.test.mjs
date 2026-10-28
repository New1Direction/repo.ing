// The Hooks revenue report replayed on the real mainnet history of both coins on our own stack (recorded read-only in
// fixtures/hooklab-revenue-mainnet.json), plus decoding of the events mainnet has not produced yet (a collection), and
// how the report behaves when the RPC fails or the history is incomplete.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadHooksMarkets, buildHooksRevenueReport } from '../src/hooklab-revenue-report.mjs'
import { decodeRevenueEvents } from '../src/hooklab-revenue-events.mjs'
import { recordedConnection } from '../src/recorded-rpc.mjs'
import { loadNativeArtifacts, loadOpenArtifacts } from '../src/hooklab-native-pins.mjs'
import { ownAddresses, ownBn, ownCreator, ownEventTransaction, ownKey, ownMint, ownProfile, signatureOf } from './fixtures/hooklab-own-stack-trades.mjs'

const recording = JSON.parse(readFileSync(new URL('./fixtures/hooklab-revenue-mainnet.json', import.meta.url), 'utf8'))
const bundle = JSON.parse(readFileSync(new URL('../config/hooklab-stack-bundle.json', import.meta.url), 'utf8'))
const idl = role => JSON.parse(Buffer.from(bundle.profile.idls[role], 'base64'))
const programs = JSON.parse(bundle.profile.json).programs, idls = { swap: idl('swap'), launch: idl('launch') }
const TREASURY = 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i', expected = { collector: TREASURY, treasury: TREASURY }
const NOW = Date.parse('2026-10-28T12:00:00Z'), fast = { attempts: 2, delayMs: 1 }
const clone = value => JSON.parse(JSON.stringify(value))
const READS = new Set(['getProgramAccounts', 'getAccountInfo', 'getMinimumBalanceForRentExemption', 'getSignaturesForAddress', 'getTransaction'])

test('mainnet replay: both coins reconcile to the lamport, with read-only RPC calls only', async () => {
  const calls = []
  const markets = await loadHooksMarkets({ connection: recordedConnection(recording, { calls }), programs, idls, treasury: TREASURY })
  const report = buildHooksRevenueReport({ markets, expected, now: NOW })
  assert.deepEqual(report.totals, { markets: 2, reconciled: 2, launchFees: '100000000', protocolAccrued: '213126', protocolCollected: '0',
    protocolPending: '213126', creatorAccrued: '639386', creatorClaimed: '639386', creatorOwed: '0', errors: '0' })
  const byPool = Object.fromEntries(report.markets.map(m => [m.pool, m]))
  assert.deepEqual(byPool['7UsXD3oc5zYDgseRCyRUApHb4fAmmVPhKcBbQRMJuDv5'].protocol, { accrued: '49750', collected: '0', pending: '49750', lastCollectionAt: null })
  assert.deepEqual(byPool.ARBeiTGidx2eGHmnqR5fA4B5t6L3TomYimvSc1oWKNXu.creator, { accrued: '490136', claimed: '490136', owed: '0', holding: '0' })
  assert.ok(report.markets.every(m => m.findings.length === 0 && m.launchFee === '50000000'))
  assert.deepEqual(report.plan.items, [])
  assert.deepEqual(report.plan.skipped.map(s => s.reason), ['below-threshold', 'below-threshold'])
  assert.equal(report.allocationPreview, undefined, 'Hooks revenue is not allocated by the platform revenue policy')
  assert.ok(calls.every(call => READS.has(call.method)), 'nothing but reads')
})

test('mainnet replay: our books\' payment records reconcile against the chain', async () => {
  const markets = await loadHooksMarkets({ connection: recordedConnection(recording), programs, idls, treasury: TREASURY })
  const payments = markets.flatMap(m => m.entries).filter(e => e.kind !== 'accrual')
  const records = payments.map(e => ({ signature: e.signature, kind: e.kind, amount: String(e.kind === 'launch' ? e.launchFee : e.amount) }))
  assert.equal(records.length, 4)
  assert.deepEqual(buildHooksRevenueReport({ markets, expected, now: NOW, records }).payments, [])
  const missing = buildHooksRevenueReport({ markets, expected, now: NOW, records: records.slice(1) }).payments
  assert.deepEqual(missing.map(f => f.code), ['UNRECORDED_PAYMENT'])
})

test('a history missing a trade does not reconcile, and the plan leaves that market alone', async () => {
  const cut = clone(recording), pool = 'ARBeiTGidx2eGHmnqR5fA4B5t6L3TomYimvSc1oWKNXu'
  const dropped = cut.signatures[pool].find(s => s.signature.startsWith('31mxDccU'))
  cut.signatures[pool] = cut.signatures[pool].filter(s => s !== dropped)
  for (const list of Object.values(cut.signatures)) list.splice(0, list.length, ...list.filter(s => s.signature !== dropped.signature))
  const markets = await loadHooksMarkets({ connection: recordedConnection(cut), programs, idls, treasury: TREASURY })
  const report = buildHooksRevenueReport({ markets, expected, now: NOW, collectionPolicy: { thresholdLamports: 1n } })
  const market = report.markets.find(m => m.pool === pool)
  // The dropped trade's 55,325 protocol share breaks the pool counter at the next trade, and its 165,978 creator share makes
  // the creator's later claim exceed what the history shows accrued.
  assert.deepEqual(market.findings.map(f => [f.code, f.signature?.slice(0, 8) ?? null]), [['PROTOCOL_CHAIN_GAP', '3VhqyL5T'], ['CREATOR_OVERPAID', null]])
  assert.equal(market.reconciled, false)
  assert.equal(report.totals.reconciled, 1)
  assert.deepEqual(report.plan.items.map(i => i.pool), ['7UsXD3oc5zYDgseRCyRUApHb4fAmmVPhKcBbQRMJuDv5'])
  assert.deepEqual(report.plan.skipped.map(s => [s.pool, s.reason]), [[pool, 'unreconciled']])
})

test('reads are retried a bounded number of times; a lasting failure or a missing transaction stops the report', async () => {
  let failures = 1
  const flaky = recordedConnection(recording), getTransaction = flaky.getTransaction.bind(flaky)
  flaky.getTransaction = (...args) => failures-- > 0 ? Promise.reject(Error('503')) : getTransaction(...args)
  assert.equal((await loadHooksMarkets({ connection: flaky, programs, idls, treasury: TREASURY, retry: fast })).length, 2)
  const down = recordedConnection(recording)
  down.getTransaction = () => Promise.reject(Error('503'))
  await assert.rejects(loadHooksMarkets({ connection: down, programs, idls, treasury: TREASURY, retry: fast }), /503/)
  const gone = clone(recording)
  delete gone.transactions[Object.keys(gone.transactions)[0]]
  await assert.rejects(loadHooksMarkets({ connection: recordedConnection(gone), programs, idls, treasury: TREASURY, retry: fast }), /RECORDING_MISSING|HOOK_REVENUE_TRANSACTION_MISSING/)
})

// Our own stack's placeholder programs and reviewed IDLs (the same event layouts as production's).
const P = ownProfile.programs, ownIdls = { swap: loadNativeArtifacts().idls.swap, launch: loadOpenArtifacts().idls.launch }
const collector = ownCreator

test('a collection decodes with what the collector actually received; an event under another authority is refused', () => {
  const tx = ownEventTransaction({ n: 90, slot: 500, program: P.swap, extraKeys: [collector], changes: { [collector]: 163_376 },
    events: [{ program: P.swap, name: 'ProtocolFeesCollected', data: { pool: ownKey(ownAddresses.pool), quote_amount: ownBn(163_376), collector: ownKey(collector), ts: ownBn(1800000090) } }] })
  const [entry] = decodeRevenueEvents(tx, { signature: signatureOf(90), programs: P, idls: ownIdls })
  assert.deepEqual({ ...entry, at: undefined }, { signature: signatureOf(90), slot: 500, at: undefined, eventIndex: 0, kind: 'collection', pool: ownAddresses.pool,
    amount: 163_376n, collector, received: 163_376n })
  const [group] = tx.meta.innerInstructions
  const forged = { ...tx, meta: { ...tx.meta, innerInstructions: [{ ...group, instructions: [{ ...group.instructions[0], accounts: [0] }] }] } }
  assert.throws(() => decodeRevenueEvents(forged, { signature: signatureOf(90), programs: P, idls: ownIdls }), /HOOK_TRADE_EVENT_UNAUTHENTICATED/)
  assert.deepEqual(decodeRevenueEvents({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, 'Custom'] } } }, { signature: signatureOf(90), programs: P, idls: ownIdls }), [])
})

test('an accrual whose shares do not add up to its gross is refused', () => {
  const accrued = { version: 1, pool: ownKey(ownAddresses.pool), quote_mint: ownKey(ownMint), direction: 1, gross_quote: ownBn(100), platform_quote: ownBn(25),
    creator_quote: ownBn(74), creator_holding: ownKey(ownMint), platform_collector: ownKey(ownMint), protocol_fees_quote_after: ownBn(25) }
  const tx = ownEventTransaction({ n: 91, slot: 501, program: P.swap, events: [{ program: P.swap, name: 'InclusiveCreatorFeeAccrued', data: accrued }] })
  assert.throws(() => decodeRevenueEvents(tx, { signature: signatureOf(91), programs: P, idls: ownIdls }), /HOOK_REVENUE_ACCRUAL_SPLIT/)
})
