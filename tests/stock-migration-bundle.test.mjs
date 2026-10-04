import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { readFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { StockCurveMigratedError, stockDbcSwapEvents, stockTradeRows } from '../src/stock-trade-evidence.mjs'
import { stockDammSwapEvents } from '../src/stock-damm-trades.mjs'

// Curve swaps, the migration and DAMM swaps bundled into one transaction, built from real transactions of the local stock-pair
// validator (mainnet's programs): the DBC buy and sell of fixtures/dbc-stock-swaps-local.json moved onto the graduated
// DOCUSAURUS / METAx market of fixtures/stock-damm-graduation.json, then its real migration and direct DAMM swaps. Two jobs read
// such a transaction: the curve indexer credits the curve swaps once the migration is proven (src/stock-fee-indexer.mjs), and
// the graduation monitor indexes the DAMM swaps (src/stock-damm-trades.mjs). Both write stock_trade_events, keyed by
// (signature, event_index), so no ordinal may be claimed by both venues.
const GRADUATION = JSON.parse(readFileSync(new URL('./fixtures/stock-damm-graduation.json', import.meta.url), 'utf8'))
const CURVE = JSON.parse(readFileSync(new URL('./fixtures/dbc-stock-swaps-local.json', import.meta.url), 'utf8'))
const { market: graduated, quoteMint, dammPool } = GRADUATION, captured = CURVE.market
const connection = new Connection('http://127.0.0.1:1')
const dbc = new DynamicBondingCurveClient(connection, 'finalized'), coder = new CpAmm(connection)._program.coder
const load = raw => normalizeFinalizedTransaction(structuredClone(raw), raw.transaction.signatures[0])
const MIGRATION = GRADUATION.transactions.migration, SIGNATURE = MIGRATION.transaction.signatures[0]

// The captured curve's pool, mint and config replaced by the graduated market's, in the account keys and in the DBC event CPIs
// (after the 8-byte event CPI tag and the 8-byte event discriminator: the pool at bytes 16..48, the config at 48..80).
const EVENT = 'e445a52e51cb9a1d'
const MOVED = { [captured.pool]: graduated.curve, [captured.mint]: graduated.mint, [captured.config]: graduated.config }
function movedEvent(data) {
  const bytes = Buffer.from(bs58.decode(data))
  if (bytes.subarray(0, 8).toString('hex') !== EVENT) return data
  for (const at of [16, 48]) {
    const to = MOVED[new PublicKey(bytes.subarray(at, at + 32)).toBase58()]
    if (to) new PublicKey(to).toBuffer().copy(bytes, at)
  }
  return bs58.encode(bytes)
}

// One finalized transaction (the migration's signature and slot) of the parts' instructions in order: their account keys merged,
// each part's inner instruction groups moved behind the outer instructions before it. move: a captured curve swap put onto the
// graduated market; without it, a swap on the captured curve (another market's).
function bundle(parts) {
  const keys = [], indexOf = new Map(), instructions = [], innerInstructions = []
  const key = address => {
    const text = address.toBase58()
    if (!indexOf.has(text)) { indexOf.set(text, keys.length); keys.push(address) }
    return indexOf.get(text)
  }
  key(parts[0].transaction.transaction.message.accountKeys[0])
  for (const { transaction, move = false } of parts) {
    const own = transaction.transaction.message.accountKeys.map(address => move && MOVED[address.toBase58()] ? new PublicKey(MOVED[address.toBase58()]) : address)
    const placed = (ix, inner) => ({ programIdIndex: key(own[ix.programIdIndex]), accounts: ix.accounts.map(at => key(own[at])),
      data: move ? movedEvent(ix.data) : ix.data, ...(inner ? { stackHeight: ix.stackHeight } : {}) })
    const base = instructions.length
    for (const ix of transaction.transaction.message.instructions) instructions.push(placed(ix, false))
    for (const group of transaction.meta.innerInstructions) {
      innerInstructions.push({ index: group.index + base, instructions: group.instructions.map(ix => placed(ix, true)) })
    }
  }
  return { slot: MIGRATION.slot, blockTime: MIGRATION.blockTime ?? null, version: 0,
    transaction: { signatures: [SIGNATURE], message: { header: { numRequiredSignatures: 1 }, accountKeys: keys, instructions } },
    meta: { err: null, innerInstructions, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [] } }
}

const market = { pool: graduated.curve, mint: graduated.mint }
const curve = { buy: () => ({ transaction: load(CURVE.buy), move: true }), sell: () => ({ transaction: load(CURVE.sell), move: true }),
  otherMarket: () => ({ transaction: load(CURVE.buy) }) }
const migration = () => ({ transaction: load(MIGRATION) })
const damm = { buy: () => ({ transaction: load(GRADUATION.transactions.directBuy) }), sell: () => ({ transaction: load(GRADUATION.transactions.directSell) }) }

// What each job reads from the bundle: the curve rows (stockTradeRows, as the curve indexer writes them) and the DAMM events.
function read(parts) {
  const transaction = bundle(parts)
  const options = migrationSignature => ({ config: graduated.config, quoteMint, migrationSignature })
  // Until the migration is proven, the curve indexer stops on it: an ERROR, its cursor unmoved, nothing credited.
  assert.throws(() => stockDbcSwapEvents(transaction, market, options(null), dbc), StockCurveMigratedError)
  assert.throws(() => stockDbcSwapEvents(transaction, market, options('another-signature'), dbc), StockCurveMigratedError)
  const rows = stockTradeRows(transaction, SIGNATURE, stockDbcSwapEvents(transaction, market, options(SIGNATURE), dbc).events)
  const events = stockDammSwapEvents(transaction, { mint: graduated.mint, quoteMint, pool: dammPool, coder })
  const ordinals = [...rows, ...events].map(row => row.eventIndex)
  assert.equal(new Set(ordinals).size, ordinals.length, `one (signature, event_index) per row: ${ordinals}`)
  return { curve: rows.map(row => [row.eventIndex, row.direction, row.quoteAmount, row.baseAmount]),
    damm: events.map(event => [event.eventIndex, event.direction]) }
}
// The captured swaps' own rows (tests/stock-trade-evidence.test.mjs): a buy's fee-excluded METAx in and tokens out; a sell's
// tokens in and METAx out.
const BUY = ['buy', 31979002n, 53455273178753n], SELL = ['sell', 20875643n, 53455273178753n]

test('a curve swap, the migration and a DAMM swap in one transaction: each job credits its own swap, under its own ordinal', () => {
  assert.deepEqual(read([curve.buy(), migration(), damm.buy()]), { curve: [[0, ...BUY]], damm: [[62, 'buy']] })
})

test('two curve swaps, the migration and two DAMM swaps in one transaction: four rows, four ordinals', () => {
  assert.deepEqual(read([curve.buy(), curve.sell(), migration(), damm.buy(), damm.sell()]),
    { curve: [[0, ...BUY], [1, ...SELL]], damm: [[67, 'buy'], [71, 'sell']] })
})

test('other markets\' curve swaps ahead raise the curve ordinal, and it still stays clear of the DAMM swap\'s', () => {
  // The curve ordinal counts every DBC swap event before it (as for SOL), and each of those sits in a group the DAMM ordinal
  // counts too, with its outer instruction and CPIs: the curve swaps come before the migration and the DAMM swaps after it.
  const others = Array.from({ length: 6 }, curve.otherMarket)
  assert.deepEqual(read([...others, curve.buy(), migration(), damm.buy()]), { curve: [[6, ...BUY]], damm: [[122, 'buy']] })
})
