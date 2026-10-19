// Hooks coin trade events, decoded from the canary's real finalized mainnet swaps (read-only fixtures). Only the swap
// program's own self-CPI events count; anything else in a transaction is ignored, and evidence that does not add up
// stops the decode instead of guessing.
import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import BN from 'bn.js'
import { HOOK_TRADE_EVENTS, decodeHookTrades } from '../src/hooklab-trade-events.mjs'
import { PROGRAMS } from '../src/hooklab-owner-driver/pins.mjs'
import { CANARY_BUY, CANARY_CLAIM, CANARY_LAUNCH, CANARY_SELL, canary, canaryConnection, clone } from './fixtures/hooklab-canary-trades.mjs'
import { ownAddresses, ownLaunch, ownProfile, ownSwap, ownTrader, signatureOf } from './fixtures/hooklab-own-stack-trades.mjs'

const pool = canary.pool
const read = async (signature, edit = null) => {
  const transactions = edit ? { ...canary.transactions, [signature]: edit(clone(canary.transactions[signature])) } : canary.transactions
  return canaryConnection({ transactions }).getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
}
// The Swapped self-CPI in both canary swaps: the only inner group, its 11th instruction.
const swapped = tx => tx.meta.innerInstructions[0].instructions[10]

test('the canary buy and sell decode to exact trades', async () => {
  assert.deepEqual(decodeHookTrades(await read(CANARY_BUY), { signature: CANARY_BUY, pool, programs: PROGRAMS }), [{
    signature: CANARY_BUY, eventIndex: 10, event: 'Swapped', quoteAsset: 'bridged-sol', pool, slot: 458573264,
    tradedAt: '2026-10-18T20:48:51.000Z', swapCount: '1', side: 'buy', trader: 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9',
    quoteAmount: '1000200', baseAmount: '1112870787571', quoteFee: '10002', curveBase: '1123887129212429', curveQuote: '1000990198' }])
  assert.deepEqual(decodeHookTrades(await read(CANARY_SELL), { signature: CANARY_SELL, pool, programs: PROGRAMS }), [{
    signature: CANARY_SELL, eventIndex: 10, event: 'Swapped', quoteAsset: 'bridged-sol', pool, slot: 458573472,
    tradedAt: '2026-10-18T20:49:37.000Z', swapCount: '2', side: 'sell', trader: 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9',
    quoteAmount: '980295', baseAmount: '1112870787571', quoteFee: '9902', curveBase: '1125000000000000', curveQuote: '1000000001' }])
})

test('the launch and the fee claim touch the pool but are not trades', async () => {
  assert.deepEqual(decodeHookTrades(await read(CANARY_LAUNCH), { signature: CANARY_LAUNCH, pool, programs: PROGRAMS }), [])
  assert.deepEqual(decodeHookTrades(await read(CANARY_CLAIM), { signature: CANARY_CLAIM, pool, programs: PROGRAMS }), [])
})

test('a failed transaction moved nothing', async () => {
  const tx = await read(CANARY_BUY, raw => { raw.meta.err = { InstructionError: [3, { Custom: 6000 }] }; return raw })
  assert.deepEqual(decodeHookTrades(tx, { signature: CANARY_BUY, pool, programs: PROGRAMS }), [])
})

test('only the swap program counts, and only for this pool', async () => {
  const tx = await read(CANARY_BUY)
  assert.deepEqual(decodeHookTrades(tx, { signature: CANARY_BUY, pool, programs: { ...PROGRAMS, swap: PROGRAMS.gate } }), [], 'another program id')
  assert.deepEqual(decodeHookTrades(tx, { signature: CANARY_BUY, pool: '5jVDpPwtbTYixQbquSWWeudDR3dLDjfLbUvVevbjM3M6', programs: PROGRAMS }), [], 'another pool in the same transaction')
  assert.throws(() => decodeHookTrades(tx, { signature: CANARY_BUY, pool: PROGRAMS.bridge, programs: PROGRAMS }), /HOOK_TRADE_POOL_MISSING/, 'the pool must be in the transaction')
  assert.throws(() => decodeHookTrades(tx, { signature: CANARY_SELL, pool, programs: PROGRAMS }), /HOOK_TRADE_SIGNATURE_MISMATCH/)
})

test('event bytes that do not authenticate stop the decode', async () => {
  // Not signed by the swap program's event authority.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { swapped(raw).accounts = [0]; return raw }), { signature: CANARY_BUY, pool, programs: PROGRAMS }),
    /HOOK_TRADE_EVENT_UNAUTHENTICATED/)
  // Not emitted by the swap program itself (its parent is the compute budget program).
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { raw.meta.innerInstructions[0].index = 0; return raw }), { signature: CANARY_BUY, pool, programs: PROGRAMS }),
    /HOOK_TRADE_EVENT_UNAUTHENTICATED/)
  // A Swapped event with a trailing byte is not the IDL's encoding.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => {
    swapped(raw).data = bs58.encode(Buffer.concat([Buffer.from(bs58.decode(swapped(raw).data)), Buffer.from([0])])); return raw
  }), { signature: CANARY_BUY, pool, programs: PROGRAMS }), /HOOK_TRADE_EVENT_ENCODING/)
  // The event names its own slot; a transaction served for another slot does not match it.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { raw.slot += 1; return raw }), { signature: CANARY_BUY, pool, programs: PROGRAMS }),
    /HOOK_TRADE_SLOT_MISMATCH/)
  // Instruction ordering must be present to prove who emitted an event.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { delete swapped(raw).stackHeight; return raw }), { signature: CANARY_BUY, pool, programs: PROGRAMS }),
    /HOOK_TRADE_ORDERING_MISSING/)
})

test('the event table drives decoding: Swapped (bridged SOL), and SwappedNative paired with it (lamports)', () => {
  assert.deepEqual(HOOK_TRADE_EVENTS.map(spec => [spec.name, spec.quoteAsset, spec.pairs ?? null]), [['Swapped', 'bridged-sol', null], ['SwappedNative', 'lamports', 'Swapped']])
  assert.ok(Object.isFrozen(HOOK_TRADE_EVENTS) && HOOK_TRADE_EVENTS.every(Object.isFrozen))
})

test('no stack is assumed: the coin\'s programs are required', async () => {
  assert.throws(() => decodeHookTrades(ownSwap({ n: 1, slot: 100 }), { signature: signatureOf(1), pool: ownAddresses.pool }), /HOOK_TRADE_PROGRAMS_MISSING/)
})

// Our own stack: every pool is native, so each swap is one lamports trade (its Swapped figures, labelled by its
// SwappedNative), and the decode reads only the coin's own swap program.
const own = { pool: ownAddresses.pool, programs: ownProfile.programs, expectNative: true }
test('a native buy and sell on our own stack decode to lamports trades, never bridged SOL', () => {
  const buy = decodeHookTrades(ownSwap({ n: 1, slot: 100 }), { signature: signatureOf(1), ...own })
  assert.deepEqual(buy, [{ signature: signatureOf(1), eventIndex: 1, event: 'SwappedNative', quoteAsset: 'lamports', pool: ownAddresses.pool, slot: 100,
    side: 'buy', trader: ownTrader, tradedAt: new Date((1800000000 + 1) * 1000).toISOString(), swapCount: '1', quoteAmount: '1000000000', baseAmount: '2000000000000',
    quoteFee: '10000000', curveBase: '1750000000000000', curveQuote: '58251917070' }])
  const sell = decodeHookTrades(ownSwap({ n: 2, slot: 101, side: 'sell', amountIn: 2000000000000n, out: 900000000n, swapCount: 2 }), { signature: signatureOf(2), ...own })
  assert.deepEqual(sell.map(t => [t.event, t.quoteAsset, t.side, t.quoteAmount, t.baseAmount, t.quoteFee, t.swapCount]),
    [['SwappedNative', 'lamports', 'sell', '890000000', '2000000000000', '10000000', '2']])
  assert.equal(decodeHookTrades(ownSwap({ n: 1, slot: 100 }), { signature: signatureOf(1), pool: ownAddresses.pool, programs: PROGRAMS }).length, 0,
    'the legacy swap program is not this coin\'s: nothing decodes')
})

test('the open launch on our own stack touches the pool but is not a trade', () => {
  assert.deepEqual(decodeHookTrades(ownLaunch({ n: 3, slot: 99 }), { signature: signatureOf(3), ...own }), [])
})

test('a native swap whose two events disagree, or that misses one, stops the decode', () => {
  const decode = (tx, options = own) => () => decodeHookTrades(tx, { signature: signatureOf(1), ...options })
  assert.throws(decode(ownSwap({ n: 1, slot: 100, edit: { native: { quote_lamports: new BN(1) } } })), /HOOK_TRADE_NATIVE_MISMATCH/)
  assert.throws(decode(ownSwap({ n: 1, slot: 100, edit: { native: { direction: 0 } } })), /HOOK_TRADE_NATIVE_MISMATCH/)
  assert.throws(decode(ownSwap({ n: 1, slot: 100, lone: true })), /HOOK_TRADE_NATIVE_MISSING/, 'our own stack only has native pools')
  // Without the native expectation (a legacy coin), a lone Swapped is a bridged-SOL trade as before.
  assert.equal(decode(ownSwap({ n: 1, slot: 100, lone: true }), { ...own, expectNative: false })()[0].quoteAsset, 'bridged-sol')
})
