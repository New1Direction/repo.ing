import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { dammSwapEvents } from '../src/damm-trades.mjs'
import { StockSwapUnmatched, stockDammSwapEvents } from '../src/stock-damm-trades.mjs'

// The strict parser for a stock-paired market's graduated pool (docs/STOCK_QUOTES.md), on real finalized transactions from
// tests/stock-graduation-chain.test.mjs (mainnet's programs on a local validator): two swaps straight on the pool and two through
// the site's trade path, and the migration that created the pool. No RPC is touched.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/stock-damm-graduation.json', import.meta.url), 'utf8'))
const solSwaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const coder = new CpAmm(new Connection('http://127.0.0.1:1'))._program.coder
const METAX = fixture.quoteMint, MSFTX = 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX'
const market = { mint: fixture.market.mint }, pool = fixture.dammPool
const load = raw => normalizeFinalizedTransaction(structuredClone(raw), raw.transaction.signatures[0])
const parse = (tx, overrides = {}) => stockDammSwapEvents(tx, { mint: market.mint, quoteMint: METAX, pool, coder, ...overrides })
const unmatched = (fn, reason) => assert.throws(fn, error => error instanceof StockSwapUnmatched && error.code === 'STOCK_DAMM_SWAP_UNMATCHED' &&
  (!reason || reason.test(error.reason)), String(reason))
const swapGroup = tx => tx.meta.innerInstructions.find(group => {
  const ix = tx.transaction.message.instructions[group.index]
  return tx.transaction.message.accountKeys[ix.programIdIndex].equals(CP_AMM_PROGRAM_ID)
})

test('real swaps on the stock pool parse to one event each, in METAx, with the market token on the other side', () => {
  const expected = { directBuy: 'buy', directSell: 'sell', siteBuy: 'buy', siteSell: 'sell' }
  for (const [name, direction] of Object.entries(expected)) {
    const tx = load(fixture.transactions[name]), events = parse(tx)
    assert.equal(events.length, 1, name)
    const [event] = events
    assert.equal(event.direction, direction, name)
    assert.ok(BigInt(event.quoteAmount) > 0n && BigInt(event.baseAmount) > 0n, name)
    assert.equal(event.trader, tx.transaction.message.accountKeys[0].toBase58(), name)
    assert.ok(BigInt(event.nextSqrtPrice) > 0n && event.tradedAt.getTime() === fixture.transactions[name].blockTime * 1000, name)
    assert.equal(event.referralFee, '0')
  }
  // quoteAmount is what the wallet paid or got; quoteVolume is stock_trade_events.quote_amount as on the curve rows: a buy's stock
  // without the pool's fee (which stays in the stock vault), a sell's stock received.
  const siteBuyEvent = parse(load(fixture.transactions.siteBuy))[0], directBuyEvent = parse(load(fixture.transactions.directBuy))[0]
  assert.deepEqual([siteBuyEvent.quoteAmount, siteBuyEvent.quoteVolume], ['50000000', '49400054'], '0.5 METAx paid, 0.00599946 of it the 1.2% fee')
  assert.deepEqual([directBuyEvent.quoteAmount, directBuyEvent.quoteVolume], ['200000000', '198000000'], '2 METAx paid, 1% fee')
  for (const name of ['directSell', 'siteSell']) {
    const [event] = parse(load(fixture.transactions[name]))
    assert.equal(event.quoteVolume, event.quoteAmount, `${name}: the stock received, its fee already taken`)
  }
  // The same ordering as the SOL parser: the event's position among its group's instructions.
  const siteBuy = load(fixture.transactions.siteBuy)
  const ordinal = siteBuy.meta.innerInstructions.slice(0, siteBuy.meta.innerInstructions.indexOf(swapGroup(siteBuy)))
    .reduce((sum, group) => sum + 1 + group.instructions.length, 0) + swapGroup(siteBuy).instructions.length
  assert.equal(parse(siteBuy)[0].eventIndex, ordinal)
  // The migration created the pool (known DAMM instructions): not a swap, nothing to record.
  assert.deepEqual(parse(load(fixture.transactions.migration)), [])
})

test('the quote mint is required, and never SOL', () => {
  const tx = load(fixture.transactions.siteBuy)
  for (const quoteMint of [undefined, null, NATIVE_MINT.toBase58()]) assert.throws(() => parse(tx, { quoteMint }), /STOCK_QUOTE_MINT_REQUIRED/)
  assert.throws(() => parse(tx, { quoteMint: 'not a key' }), /STOCK_QUOTE_MINT is required/)
})

test('the trap: a stock swap the SOL parser passes over is quarantined here, never "not a swap"', () => {
  const tx = load(fixture.transactions.siteBuy)
  // The SOL DAMM parser only follows SOL-quoted swaps: on the stock pool it records nothing.
  assert.deepEqual(dammSwapEvents(tx, market, pool, coder), [])
  // Told the wrong stock, the strict parser refuses the swap instead of skipping it.
  unmatched(() => parse(tx, { quoteMint: MSFTX }), /other mints/)
  unmatched(() => parse(tx, { mint: Keypair.generate().publicKey.toBase58() }), /other mints/)
  // A SOL pool's swap, read as a stock pool's: refused too.
  const solTx = load(solSwaps.buy)
  unmatched(() => stockDammSwapEvents(solTx, { mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', quoteMint: METAX, pool: solSwaps.pool, coder }), /other mints/)
  // Another pool's swaps are not this pool's.
  assert.deepEqual(parse(solTx), [])
  assert.deepEqual(parse(tx, { pool: Keypair.generate().publicKey.toBase58() }), [])
})

test('a swap without exactly one event, an event without its swap, or an event that does not decode is quarantined', () => {
  const eventAt = tx => swapGroup(tx).instructions.findIndex(ix => Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d')
  const noEvent = load(fixture.transactions.siteSell)
  swapGroup(noEvent).instructions.splice(eventAt(noEvent), 1)
  unmatched(() => parse(noEvent), /exactly one swap event/)
  const twoEvents = load(fixture.transactions.siteSell)
  swapGroup(twoEvents).instructions.push(structuredClone(swapGroup(twoEvents).instructions[eventAt(twoEvents)]))
  unmatched(() => parse(twoEvents), /exactly one swap event/)
  // The event lifted out of its swap (as if emitted by some other instruction at the top level of the group).
  const orphan = load(fixture.transactions.siteSell), group = swapGroup(orphan)
  const outerIndex = group.index
  orphan.transaction.message.instructions[outerIndex] = { ...orphan.transaction.message.instructions[outerIndex],
    data: bs58.encode(Buffer.from('0123456789abcdef', 'hex')), accounts: [] }
  unmatched(() => parse(orphan), /came from no swap/)
  const garbled = load(fixture.transactions.siteSell), event = swapGroup(garbled).instructions[eventAt(garbled)]
  event.data = bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), Buffer.alloc(24, 7)]))
  unmatched(() => parse(garbled), /does not decode/)
  // No inner instructions at all: the swap never reported itself.
  const bare = load(fixture.transactions.siteSell)
  bare.meta.innerInstructions = []
  unmatched(() => parse(bare), /emitted no event/)
})

test('an event that collects fees outside the stock, or an instruction the coder does not know on the pool, is quarantined', () => {
  const tx = load(fixture.transactions.siteBuy), group = swapGroup(tx)
  const event = group.instructions.find(ix => Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d')
  const bytes = Buffer.from(bs58.decode(event.data))
  // EVENT prefix (8) + event discriminator (8) + pool (32) + trade direction (1), then the collect fee mode.
  assert.equal(bytes[8 + 8 + 32 + 1], 1)
  bytes[8 + 8 + 32 + 1] = 0
  event.data = bs58.encode(bytes)
  unmatched(() => parse(tx), /outside the stock/)
  const unknown = load(fixture.transactions.siteBuy), swap = unknown.transaction.message.instructions[swapGroup(unknown).index]
  unknown.transaction.message.instructions.push({ ...swap, data: bs58.encode(Buffer.from('ffeeddccbbaa9988', 'hex')) })
  unmatched(() => parse(unknown), /does not know/)
  // A swap that names the pool in some other position.
  const misplaced = load(fixture.transactions.siteBuy), outer = misplaced.transaction.message.instructions[swapGroup(misplaced).index]
  misplaced.transaction.message.instructions.push({ ...outer, accounts: [outer.accounts[0], outer.accounts[0], ...outer.accounts.slice(2), outer.accounts[1]] })
  misplaced.meta.innerInstructions.push({ index: misplaced.transaction.message.instructions.length - 1, instructions: [] })
  unmatched(() => parse(misplaced), /outside its pool account/)
})

test('a transfer fee on the stock, or a fee-excluded amount above what was paid, is quarantined', () => {
  // Field offsets in the event (after the 8-byte EVENT prefix and 8-byte discriminator): pool 32, direction 1, fee mode 1,
  // referral 1, params 17, then the swap result: included-fee input u64, excluded-fee input u64, amount left, output, ...
  const resultAt = 8 + 8 + 32 + 1 + 1 + 1 + 17
  const eventOf = tx => swapGroup(tx).instructions.find(ix => Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d')
  const buy = load(fixture.transactions.siteBuy), buyEvent = eventOf(buy)
  const buyBytes = Buffer.from(bs58.decode(buyEvent.data))
  assert.equal(buyBytes.readBigUInt64LE(resultAt), 50_000_000n, 'included-fee input')
  buyBytes.writeBigUInt64LE(49_999_000n, resultAt)
  buyEvent.data = bs58.encode(buyBytes)
  unmatched(() => parse(buy), /transfer fee on the stock/)
  const above = load(fixture.transactions.siteBuy), aboveEvent = eventOf(above)
  const aboveBytes = Buffer.from(bs58.decode(aboveEvent.data))
  assert.equal(aboveBytes.readBigUInt64LE(resultAt + 8), 49_400_054n, 'excluded-fee input')
  aboveBytes.writeBigUInt64LE(50_000_001n, resultAt + 8)
  aboveEvent.data = bs58.encode(aboveBytes)
  unmatched(() => parse(above), /fee-excluded stock amount/)
})

test('a transaction without recorded inner instructions is quarantined; a dust swap with nothing out is still a swap', () => {
  for (const missing of [undefined, null]) {
    const tx = load(fixture.transactions.siteBuy)
    tx.meta.innerInstructions = missing
    unmatched(() => parse(tx), /no recorded inner instructions/)
  }
  // The buy's event with nothing out (a fee that took the whole input): recorded with its zero, so a dust swap cannot pin a
  // market in REVIEW.
  const dust = load(fixture.transactions.siteBuy), group = swapGroup(dust)
  const event = group.instructions.find(ix => Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d')
  const bytes = Buffer.from(bs58.decode(event.data)), decoded = coder.events.decode(bytes.subarray(8).toString('base64')).data
  // The event ends with the amount out (transfer fee included, then excluded), the timestamp and both reserves, u64 each.
  const outAt = bytes.length - 8 * 4
  assert.equal(bytes.readBigUInt64LE(outAt), BigInt(decoded.excludedTransferFeeAmountOut.toString()), 'excluded amount out')
  assert.equal(bytes.readBigUInt64LE(outAt + 8), BigInt(decoded.currentTimestamp.toString()), 'then the timestamp')
  bytes.writeBigUInt64LE(0n, outAt)
  event.data = bs58.encode(bytes)
  const [zero] = parse(dust)
  assert.deepEqual([zero.direction, zero.quoteAmount, zero.baseAmount], ['buy', '50000000', '0'])
})

test('a failed or missing transaction is not evidence', () => {
  const failed = load(fixture.transactions.siteBuy)
  failed.meta.err = { InstructionError: [4, { Custom: 6004 }] }
  assert.throws(() => parse(failed), /DAMM_TRADE_EVIDENCE_MISSING/)
  assert.throws(() => parse(null), /DAMM_TRADE_EVIDENCE_MISSING/)
  const unordered = load(fixture.transactions.siteBuy)
  for (const ix of swapGroup(unordered).instructions) delete ix.stackHeight
  assert.throws(() => parse(unordered), /DAMM_TRADE_ORDERING_MISSING/)
  assert.ok(new PublicKey(pool))
})
