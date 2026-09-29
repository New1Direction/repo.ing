import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { readFileSync } from 'node:fs'
import { Connection } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { canonicalDbcSwapEvents, canonicalTradeEvents, UnparseableTradeError } from '../src/trade-evidence.mjs'

// Mainnet swap2 (slot 451510431): the program emits evtSwap then evtSwap2 for the same sell.
const SIGNATURE = '5bMSThjxQL4LDoKnSZkZkjRLYy6ggGcaW6tr1yTZEgmjZfY3wFaqZW7rEDA7bBhjppnzVxqaVX4Y1EQjK6oMMgvc'
const raw = JSON.parse(readFileSync(new URL('./fixtures/dbc-swap2-mainnet.json', import.meta.url)))
const market = { pool: '7r5iNAJcjLho4rCYu71D5sSbk4Hwg7uZBZoKVAXyHdc1', mint: '4axvA9WtT1xhEaofaSxaVm2KzZCco4eax2HnzJLqQdYn', signature: SIGNATURE }
const config = 'BePhDoh7TVPpQGNG7L5yPerN11DCXMJ3DVRQxHtgeMBV'
const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'finalized')
const coder = dbc.state.getProgram().coder.events
const eventName = instruction => {
  const bytes = Buffer.from(bs58.decode(instruction.data))
  return bytes.subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d' ? coder.decode(bytes.subarray(8).toString('base64'))?.name : null
}
const without = name => ({ ...raw, meta: { ...raw.meta, innerInstructions: raw.meta.innerInstructions.map(group =>
  ({ ...group, instructions: group.instructions.filter(instruction => eventName(instruction) !== name) })) } })
const facts = ({ events }) => events.map(({ eventIndex, data }) => ({ eventIndex, pool: data.pool.toBase58(),
  direction: data.tradeDirection, timestamp: data.currentTimestamp.toString(),
  ...Object.fromEntries(['actualInputAmount', 'outputAmount', 'nextSqrtPrice', 'tradingFee', 'protocolFee', 'referralFee']
    .map(field => [field, data.swapResult[field].toString()])) }))
const LOGGED = [{ eventIndex: 0, pool: market.pool, direction: 0, timestamp: '1790649812', actualInputAmount: '203363672029',
  outputAmount: '116724093', nextSqrtPrice: '442326561584136422', tradingFee: '234034', protocolFee: '58508', referralFee: '0' }]

test('real mainnet swap2 credits exactly one trade although it emits evtSwap and evtSwap2', () => {
  const tx = normalizeFinalizedTransaction(raw, SIGNATURE)
  assert.deepEqual(raw.meta.innerInstructions.flatMap(group => group.instructions.map(eventName)).filter(Boolean), ['evtSwap', 'evtSwap2'])
  const result = canonicalDbcSwapEvents(tx, market, config, dbc)
  assert.equal(result.sawCanonicalSwap, true)
  assert.equal(result.sawCanonicalFeeEvent, true)
  assert.deepEqual(facts(result), LOGGED)
})

test('evtSwap2-only emission yields the same fee facts and ordinal as the logged evtSwap', () => {
  const tx = normalizeFinalizedTransaction(without('evtSwap'), SIGNATURE)
  const result = canonicalDbcSwapEvents(tx, market, config, dbc)
  assert.equal(result.sawCanonicalFeeEvent, true)
  assert.deepEqual(facts(result), LOGGED)
  const [trade] = canonicalTradeEvents(tx, market, config, dbc)
  assert.deepEqual([trade.eventIndex, trade.direction, trade.inputBaseUnits, trade.outputBaseUnits, trade.nextSqrtPrice],
    [0, 'sell', '203363672029', '116724093', '442326561584136422'])
})

test('a canonical swap with no swap event is unparseable, not a transient failure', () => {
  const stripped = without('evtSwap2')
  const tx = normalizeFinalizedTransaction({ ...stripped, meta: { ...stripped.meta, innerInstructions: stripped.meta.innerInstructions
    .map(group => ({ ...group, instructions: group.instructions.filter(instruction => eventName(instruction) !== 'evtSwap') })) } }, SIGNATURE)
  const result = canonicalDbcSwapEvents(tx, market, config, dbc)
  assert.deepEqual([result.sawCanonicalSwap, result.sawCanonicalFeeEvent, result.events.length], [true, false, 0])
  const corrupt = structuredClone(raw)
  const group = corrupt.meta.innerInstructions.find(group => group.instructions.some(eventName))
  const instruction = group.instructions.find(instruction => eventName(instruction) === 'evtSwap')
  instruction.data = bs58.encode(Buffer.from(bs58.decode(instruction.data)).subarray(0, 40))
  assert.throws(() => canonicalDbcSwapEvents(normalizeFinalizedTransaction(corrupt, SIGNATURE), market, config, dbc), UnparseableTradeError)
})

test('stored ordinals stay stable: paired evtSwap2 never takes an event index', () => {
  const tx = normalizeFinalizedTransaction(raw, SIGNATURE)
  const group = tx.meta.innerInstructions.find(group => group.instructions.some(eventName))
  const swap = tx.transaction.message.instructions[group.index]
  // Duplicate the whole swap as a second outer instruction: two trades, two ordinals (0, 1), not four.
  const doubled = { ...tx, transaction: { ...tx.transaction, message: { ...tx.transaction.message,
    instructions: [...tx.transaction.message.instructions, swap] } },
  meta: { ...tx.meta, innerInstructions: [...tx.meta.innerInstructions, { ...group, index: tx.transaction.message.instructions.length }] } }
  assert.deepEqual(canonicalDbcSwapEvents(doubled, market, config, dbc).events.map(event => event.eventIndex), [0, 1])
  const mixed = { ...doubled, meta: { ...doubled.meta, innerInstructions: [...tx.meta.innerInstructions,
    { ...group, index: tx.transaction.message.instructions.length, instructions: group.instructions.filter(instruction => eventName(instruction) !== 'evtSwap') }] } }
  const events = canonicalDbcSwapEvents(mixed, market, config, dbc).events
  assert.deepEqual(events.map(event => [event.eventIndex, event.data.swapResult.tradingFee.toString()]), [[0, '234034'], [1, '234034']])
})
