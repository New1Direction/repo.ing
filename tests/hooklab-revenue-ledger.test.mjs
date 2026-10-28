// The Hooks revenue ledger's invariants, on hand-made entries in the shape src/hooklab-revenue-events.mjs decodes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMarketLedger, dedupeEntries, reconcilePayments, revenueTotals } from '../src/hooklab-revenue-ledger.mjs'

const POOL = 'Poo1111111111111111111111111111111111111111', LAUNCH = 'Launch1111111111111111111111111111111111111'
const TREASURY = 'Treasury11111111111111111111111111111111111', CREATOR = 'Creator111111111111111111111111111111111111'
const OTHER = 'Other111111111111111111111111111111111111111'
const expected = { collector: TREASURY, treasury: TREASURY }
let n = 0
const sig = () => `sig${++n}`
const launch = (over = {}) => ({ signature: sig(), slot: 1, eventIndex: 0, kind: 'launch', pool: POOL, mint: 'Mint', launch: LAUNCH, creator: CREATOR,
  launchFee: 50_000_000n, received: 50_000_000n, ...over })
const accrual = (slot, protocol, pendingAfter, over = {}) => ({ signature: sig(), slot, eventIndex: 5, kind: 'accrual', pool: POOL, gross: protocol * 4n,
  protocol, creator: protocol * 3n, collector: TREASURY, creatorHolding: LAUNCH, pendingAfter, ...over })
const collection = (slot, amount, over = {}) => ({ signature: sig(), slot, at: '2026-10-28T06:00:00.000Z', eventIndex: 3, kind: 'collection', pool: POOL,
  amount, collector: TREASURY, received: amount, ...over })
const claim = (slot, amount, claimedTotal, over = {}) => ({ signature: sig(), slot, eventIndex: 0, kind: 'creator-claim', launch: LAUNCH, mint: 'Mint',
  creator: CREATOR, amount, claimedTotal, received: amount, ...over })
const codes = ledger => ledger.findings.map(f => f.code)
const ledgerOf = (entries, chain = {}) => buildMarketLedger({ pool: POOL, entries, chain, expected })

test('a full history reconciles: launch fee, trade shares, a collection, more trades and a creator claim', () => {
  const entries = [launch(), accrual(2, 25_000n, 25_000n), accrual(3, 24_750n, 49_750n), collection(4, 49_750n), accrual(5, 1000n, 1000n), claim(6, 151_500n, 151_500n)]
  // The launch account holds the 750 the creator earned after the claim, above its rent.
  const ledger = ledgerOf(entries, { protocolFeesQuote: 1000n, launchLamports: 3_520_440n + 750n, launchRentExempt: 3_520_440n })
  assert.deepEqual(codes(ledger), [])
  assert.equal(ledger.reconciled, true)
  assert.deepEqual({ ...ledger.protocol }, { accrued: 50_750n, collected: 49_750n, pending: 1000n, lastCollectionAt: '2026-10-28T06:00:00.000Z' })
  assert.deepEqual({ ...ledger.creator }, { accrued: 152_250n, claimed: 151_500n, owed: 750n, holding: 750n })
  // Holding only its rent, the launch account would be 750 short of what the creator is owed.
  assert.deepEqual(codes(ledgerOf(entries, { protocolFeesQuote: 1000n, launchLamports: 3_520_440n, launchRentExempt: 3_520_440n })), ['CREATOR_HOLDING_SHORTFALL'])
  assert.equal(ledger.protocol.accrued, ledger.protocol.collected + ledger.protocol.pending, 'accrued = collected + pending')
})

test('a missing trade breaks the protocol chain once, then the ledger follows the chain again', () => {
  const ledger = ledgerOf([launch(), accrual(2, 25_000n, 25_000n), accrual(4, 1000n, 50_750n), accrual(5, 250n, 51_000n)], { protocolFeesQuote: 51_000n })
  assert.deepEqual(codes(ledger), ['PROTOCOL_CHAIN_GAP'])
  assert.equal(ledger.reconciled, false)
  assert.equal(ledger.protocol.pending, 51_000n)
})

test('a pool holding more or less than its history adds up to is a mismatch', () => {
  assert.deepEqual(codes(ledgerOf([launch(), accrual(2, 25_000n, 25_000n)], { protocolFeesQuote: 30_000n })), ['PROTOCOL_PENDING_MISMATCH'])
})

test('collections: only the expected collector, only the whole pending amount, and it must arrive', () => {
  const base = () => [launch(), accrual(2, 25_000n, 25_000n)]
  assert.deepEqual(codes(ledgerOf([...base(), collection(3, 25_000n, { collector: OTHER, received: null })], { protocolFeesQuote: 0n })), ['UNEXPECTED_COLLECTOR'])
  assert.deepEqual(codes(ledgerOf([...base(), collection(3, 20_000n)], { protocolFeesQuote: 0n })), ['COLLECTION_AMOUNT_MISMATCH'])
  assert.deepEqual(codes(ledgerOf([...base(), collection(3, 25_000n, { received: 24_000n })], { protocolFeesQuote: 0n })), ['COLLECTION_NOT_RECEIVED'])
  // A second collection of an already emptied pool pays nothing, and the ledger counts nothing twice.
  const twice = ledgerOf([...base(), collection(3, 25_000n), collection(4, 0n)], { protocolFeesQuote: 0n })
  assert.deepEqual([codes(twice), twice.protocol.collected], [[], 25_000n])
  assert.deepEqual(codes(ledgerOf([launch(), accrual(2, 10n, 10n, { collector: OTHER })], { protocolFeesQuote: 10n })), ['UNEXPECTED_COLLECTOR'])
})

test('creator claims follow the launch claimed total, go only to the creator and never exceed what accrued', () => {
  const base = () => [launch(), accrual(2, 25_000n, 25_000n)]
  assert.deepEqual(codes(ledgerOf([...base(), claim(3, 75_000n, 80_000n)])), ['CREATOR_CLAIM_GAP', 'CREATOR_OVERPAID'])
  assert.deepEqual(codes(ledgerOf([...base(), claim(3, 75_000n, 75_000n, { creator: OTHER })])), ['UNEXPECTED_CLAIMANT'])
  assert.deepEqual(codes(ledgerOf([...base(), claim(3, 75_000n, 75_000n, { received: 70_000n })])), ['CREATOR_CLAIM_NOT_RECEIVED'])
  assert.deepEqual(codes(ledgerOf([launch(), accrual(2, 25_000n, 25_000n, { creatorHolding: OTHER })])), ['CREATOR_HOLDING_MISMATCH'])
  const rent = 3_520_440n
  assert.deepEqual(codes(ledgerOf(base(), { launchLamports: rent + 70_000n, launchRentExempt: rent })), ['CREATOR_HOLDING_SHORTFALL'])
  assert.deepEqual(codes(ledgerOf(base(), { launchLamports: rent + 80_000n, launchRentExempt: rent })), ['CREATOR_HOLDING_SURPLUS'])
  assert.equal(ledgerOf(base(), { launchLamports: rent + 80_000n, launchRentExempt: rent }).reconciled, true, 'a surplus is a warning: the creator can claim it')
})

test('launch fees: one launch per pool, and the treasury must receive the fee', () => {
  assert.deepEqual(codes(ledgerOf([launch({ received: 0n })])), ['LAUNCH_FEE_NOT_RECEIVED'])
  assert.deepEqual(codes(ledgerOf([launch(), launch()])), ['LAUNCH_DUPLICATE'])
  assert.deepEqual(codes(ledgerOf([accrual(2, 10n, 10n)], { protocolFeesQuote: 10n })), ['LAUNCH_MISSING'])
})

test('the same event from two overlapping histories is one entry', () => {
  const one = launch(), entries = [one, { ...one }, accrual(2, 10n, 10n)]
  assert.equal(dedupeEntries(entries).deduplicated, 1)
  const ledger = ledgerOf(entries, { protocolFeesQuote: 10n })
  assert.deepEqual([codes(ledger), ledger.deduplicated, ledger.launchFee], [[], 1, 50_000_000n])
})

test('payment records: unrecorded, unexpected, duplicate and mismatched payments are each reported', () => {
  const fee = launch(), take = collection(3, 25_000n), paidOut = claim(4, 75_000n, 75_000n)
  const entries = [fee, accrual(2, 25_000n, 25_000n), take, paidOut]
  assert.deepEqual(reconcilePayments({ entries, records: [{ signature: fee.signature, kind: 'launch', amount: '50000000' },
    { signature: take.signature, kind: 'collection', amount: '25000' }, { signature: paidOut.signature, kind: 'creator-claim', amount: '75000' }] }), [])
  const findings = reconcilePayments({ entries, records: [{ signature: fee.signature, kind: 'launch', amount: '50000000' },
    { signature: fee.signature, kind: 'launch', amount: '50000000' }, { signature: take.signature, kind: 'collection', amount: '24000' },
    { signature: 'ghost', kind: 'collection', amount: '1' }] })
  assert.deepEqual(findings.map(f => [f.code, f.signature]), [['DUPLICATE_PAYMENT_RECORD', fee.signature], ['PAYMENT_AMOUNT_MISMATCH', take.signature],
    ['UNEXPECTED_PAYMENT_RECORD', 'ghost'], ['UNRECORDED_PAYMENT', paidOut.signature]])
})

test('totals add every market', () => {
  const a = ledgerOf([launch(), accrual(2, 10n, 10n)], { protocolFeesQuote: 10n })
  const b = buildMarketLedger({ pool: 'B', entries: [{ ...launch(), pool: 'B' }, { ...accrual(2, 5n, 5n), pool: 'B', creatorHolding: LAUNCH }], chain: { protocolFeesQuote: 5n }, expected })
  assert.deepEqual({ ...revenueTotals([a, b]) }, { markets: 2, reconciled: 2, launchFees: 100_000_000n, protocolAccrued: 15n, protocolCollected: 0n,
    protocolPending: 15n, creatorAccrued: 45n, creatorClaimed: 0n, creatorOwed: 45n, errors: 0n })
})
