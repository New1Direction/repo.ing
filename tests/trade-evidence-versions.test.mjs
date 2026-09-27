import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { canonicalDbcSwapEvents, canonicalTradeEvents } from '../src/trade-evidence.mjs'

const dbcProgram = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const prefix = Buffer.from('e445a52e51cb9a1d', 'hex')
const swap2 = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136])
const key = () => Keypair.generate().publicKey
const pool = key(), mint = key(), config = key(), aggregator = key()
const keys = [dbcProgram, config, pool, mint, NATIVE_MINT, aggregator]
const accounts = Array(15).fill(0)
accounts[1] = 1; accounts[2] = 2; accounts[7] = 3; accounts[8] = 4
const instruction = (programIdIndex, data, stackHeight, accountsForInstruction = accounts) =>
  ({ programIdIndex, accounts: accountsForInstruction, data: bs58.encode(data), stackHeight })
const swapInstruction = depth => instruction(0, swap2, depth)
const eventInstruction = (kind, depth) => instruction(0, Buffer.concat([prefix, Buffer.from([kind])]), depth, [0])
const decode = encoded => ({
  name: Buffer.from(encoded, 'base64')[0] === 1 ? 'evtSwap' : 'evtSwap2',
  data: { pool, config, tradeDirection: 1, currentTimestamp: { toString: () => '1000' },
    swapResult: { tradingFee: { toString: () => '2100' }, actualInputAmount: { toString: () => '1000' },
      outputAmount: { isZero: () => false, toString: () => '900' },
      nextSqrtPrice: { isZero: () => false, toString: () => '123' } } },
})
const dbc = { state: { getProgram: () => ({ coder: { events: { decode } } }) } }
const market = { pool: pool.toBase58(), mint: mint.toBase58(), signature: 'test-signature' }

function transaction(outer, inner) {
  return { slot: 99, transaction: { message: { accountKeys: keys, instructions: [outer] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: inner }] } }
}

test('direct swap2 has one canonical fee and chart event despite duplicate evtSwap2', () => {
  const tx = transaction(swapInstruction(1), [eventInstruction(1, 2), eventInstruction(2, 2)])
  const result = canonicalDbcSwapEvents(tx, market, config, dbc)
  assert.equal(result.sawCanonicalSwap, true)
  assert.equal(result.sawCanonicalFeeEvent, true)
  assert.equal(result.events.length, 1)
  assert.equal(canonicalTradeEvents(tx, market, config, dbc)[0].direction, 'buy')
})

test('aggregator CPI swap2 is attributed to its matching pool and parent depth', () => {
  const outer = instruction(5, Buffer.from([0]), 1, [])
  const tx = transaction(outer, [swapInstruction(2), eventInstruction(1, 3)])
  assert.equal(canonicalDbcSwapEvents(tx, market, config, dbc).events.length, 1)
  assert.equal(canonicalTradeEvents(tx, market, config, dbc)[0].inputBaseUnits, '1000')
  const wrongPool = { ...market, pool: key().toBase58() }
  assert.equal(canonicalDbcSwapEvents(tx, wrongPool, config, dbc).events.length, 0)
})
