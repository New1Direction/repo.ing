// Hooks coin trade events, decoded from the canary's real finalized mainnet swaps (read-only fixtures). Only the swap
// program's own self-CPI events count; anything else in a transaction is ignored, and evidence that does not add up
// stops the decode instead of guessing.
import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { HOOK_TRADE_EVENTS, decodeHookTrades } from '../src/hooklab-trade-events.mjs'
import { PROGRAMS } from '../src/hooklab-owner-driver/pins.mjs'
import { CANARY_BUY, CANARY_CLAIM, CANARY_LAUNCH, CANARY_SELL, canary, canaryConnection, clone } from './fixtures/hooklab-canary-trades.mjs'

const pool = canary.pool
const read = async (signature, edit = null) => {
  const transactions = edit ? { ...canary.transactions, [signature]: edit(clone(canary.transactions[signature])) } : canary.transactions
  return canaryConnection({ transactions }).getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
}
// The Swapped self-CPI in both canary swaps: the only inner group, its 11th instruction.
const swapped = tx => tx.meta.innerInstructions[0].instructions[10]

test('the canary buy and sell decode to exact trades', async () => {
  assert.deepEqual(decodeHookTrades(await read(CANARY_BUY), { signature: CANARY_BUY, pool }), [{
    signature: CANARY_BUY, eventIndex: 10, event: 'Swapped', quoteAsset: 'bridged-sol', pool, slot: 458573264,
    tradedAt: '2026-10-18T20:48:51.000Z', swapCount: '1', side: 'buy', trader: 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9',
    quoteAmount: '1000200', baseAmount: '1112870787571', quoteFee: '10002', curveBase: '1123887129212429', curveQuote: '1000990198' }])
  assert.deepEqual(decodeHookTrades(await read(CANARY_SELL), { signature: CANARY_SELL, pool }), [{
    signature: CANARY_SELL, eventIndex: 10, event: 'Swapped', quoteAsset: 'bridged-sol', pool, slot: 458573472,
    tradedAt: '2026-10-18T20:49:37.000Z', swapCount: '2', side: 'sell', trader: 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9',
    quoteAmount: '980295', baseAmount: '1112870787571', quoteFee: '9902', curveBase: '1125000000000000', curveQuote: '1000000001' }])
})

test('the launch and the fee claim touch the pool but are not trades', async () => {
  assert.deepEqual(decodeHookTrades(await read(CANARY_LAUNCH), { signature: CANARY_LAUNCH, pool }), [])
  assert.deepEqual(decodeHookTrades(await read(CANARY_CLAIM), { signature: CANARY_CLAIM, pool }), [])
})

test('a failed transaction moved nothing', async () => {
  const tx = await read(CANARY_BUY, raw => { raw.meta.err = { InstructionError: [3, { Custom: 6000 }] }; return raw })
  assert.deepEqual(decodeHookTrades(tx, { signature: CANARY_BUY, pool }), [])
})

test('only the swap program counts, and only for this pool', async () => {
  const tx = await read(CANARY_BUY)
  assert.deepEqual(decodeHookTrades(tx, { signature: CANARY_BUY, pool, programs: { ...PROGRAMS, swap: PROGRAMS.gate } }), [], 'another program id')
  assert.deepEqual(decodeHookTrades(tx, { signature: CANARY_BUY, pool: '5jVDpPwtbTYixQbquSWWeudDR3dLDjfLbUvVevbjM3M6' }), [], 'another pool in the same transaction')
  assert.throws(() => decodeHookTrades(tx, { signature: CANARY_BUY, pool: PROGRAMS.bridge }), /HOOK_TRADE_POOL_MISSING/, 'the pool must be in the transaction')
  assert.throws(() => decodeHookTrades(tx, { signature: CANARY_SELL, pool }), /HOOK_TRADE_SIGNATURE_MISMATCH/)
})

test('event bytes that do not authenticate stop the decode', async () => {
  // Not signed by the swap program's event authority.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { swapped(raw).accounts = [0]; return raw }), { signature: CANARY_BUY, pool }),
    /HOOK_TRADE_EVENT_UNAUTHENTICATED/)
  // Not emitted by the swap program itself (its parent is the compute budget program).
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { raw.meta.innerInstructions[0].index = 0; return raw }), { signature: CANARY_BUY, pool }),
    /HOOK_TRADE_EVENT_UNAUTHENTICATED/)
  // A Swapped event with a trailing byte is not the IDL's encoding.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => {
    swapped(raw).data = bs58.encode(Buffer.concat([Buffer.from(bs58.decode(swapped(raw).data)), Buffer.from([0])])); return raw
  }), { signature: CANARY_BUY, pool }), /HOOK_TRADE_EVENT_ENCODING/)
  // The event names its own slot; a transaction served for another slot does not match it.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { raw.slot += 1; return raw }), { signature: CANARY_BUY, pool }),
    /HOOK_TRADE_SLOT_MISMATCH/)
  // Instruction ordering must be present to prove who emitted an event.
  await assert.rejects(async () => decodeHookTrades(await read(CANARY_BUY, raw => { delete swapped(raw).stackHeight; return raw }), { signature: CANARY_BUY, pool }),
    /HOOK_TRADE_ORDERING_MISSING/)
})

test('the event table drives decoding: Swapped today', () => {
  assert.deepEqual(HOOK_TRADE_EVENTS.map(spec => [spec.name, spec.quoteAsset]), [['Swapped', 'bridged-sol']])
  assert.ok(Object.isFrozen(HOOK_TRADE_EVENTS) && HOOK_TRADE_EVENTS.every(Object.isFrozen))
})

// TODO(native-sol): native-SOL pools emit SwappedNative (quote in lamports). Once its IDL is pinned, add its row to
// HOOK_TRADE_EVENTS and replace this with a decode of a real SwappedNative swap.
test.todo('SwappedNative from a native-SOL pool decodes with its quote in lamports')
