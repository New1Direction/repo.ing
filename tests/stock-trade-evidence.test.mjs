import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { readFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { canonicalDbcSwapEvents, UnparseableTradeError } from '../src/trade-evidence.mjs'
import { STOCK_DBC_INSTRUCTIONS, StockCurveMigratedError, StockEvidenceUnmatchedError, stockDbcSwapEvents, stockTradeRows }
  from '../src/stock-trade-evidence.mjs'
import { QUOTE_REGISTRY } from '../src/quote-assets.mjs'

// The strict stock-pair swap parser (docs/STOCK_QUOTES.md) on real transactions: a DOCUSAURUS / METAx launch, buy and sell
// captured from the local stock-pair validator (mainnet's DBC and Token-2022 programs, the real METAx mint), and the SOL
// mainnet swap2 the SOL parser is tested on.
const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'finalized')
const program = dbc.state.getProgram()
const STOCK = JSON.parse(readFileSync(new URL('./fixtures/dbc-stock-swaps-local.json', import.meta.url)))
const { market, config, quoteMint } = { market: STOCK.market, config: STOCK.market.config, quoteMint: STOCK.market.quoteMint }
const tx = name => normalizeFinalizedTransaction(structuredClone(STOCK[name]), STOCK[name].transaction.signatures[0])
const parse = (transaction, options = { config, quoteMint }) => stockDbcSwapEvents(transaction, market, options, dbc)
const EVENT = 'e445a52e51cb9a1d'
const isEvent = instruction => Buffer.from(bs58.decode(instruction.data)).subarray(0, 8).toString('hex') === EVENT
const eventName = instruction => program.coder.events.decode(Buffer.from(bs58.decode(instruction.data)).subarray(8).toString('base64'))?.name
const swapGroup = transaction => transaction.meta.innerInstructions.find(group => group.instructions.some(isEvent))
const facts = ({ events }) => events.map(({ eventIndex, data, trader }) => ({ eventIndex, trader, direction: data.tradeDirection,
  pool: data.pool.toBase58(), config: data.config.toBase58(),
  ...Object.fromEntries(['actualInputAmount', 'outputAmount', 'tradingFee', 'protocolFee'].map(field => [field, data.swapResult[field].toString()])) }))
// The instruction data of an event re-encoded after `change` (the program's own coder: the bytes round-trip exactly).
function reencoded(instruction, change) {
  const bytes = Buffer.from(bs58.decode(instruction.data))
  const decoded = program.coder.events.decode(bytes.subarray(8).toString('base64'))
  change(decoded.data)
  const discriminator = Buffer.from(program.idl.events.find(event => event.name === decoded.name).discriminator)
  return bs58.encode(Buffer.concat([bytes.subarray(0, 8), discriminator, program.coder.types.encode(decoded.name, decoded.data)]))
}
const keyIndex = (transaction, address) => transaction.transaction.message.accountKeys.findIndex(key => key.equals(new PublicKey(address)))
const dbcIndex = transaction => keyIndex(transaction, 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const unmatched = (transaction, pattern) => assert.throws(() => parse(transaction), error =>
  error instanceof StockEvidenceUnmatchedError && error instanceof UnparseableTradeError && pattern.test(error.message))

test('a METAx buy and sell from the validator: one canonical event each, with the swap\'s own fee facts', () => {
  const buy = parse(tx('buy')), sell = parse(tx('sell'))
  const wallet = STOCK.buy.transaction.message.accountKeys[0]
  assert.deepEqual(facts(buy), [{ eventIndex: 0, trader: wallet, direction: 1, pool: market.pool, config,
    actualInputAmount: '31979002', outputAmount: '53455273178753', tradingFee: '14416799', protocolFee: '3604199' }])
  assert.deepEqual(facts(sell), [{ eventIndex: 0, trader: wallet, direction: 0, pool: market.pool, config,
    actualInputAmount: '53455273178753', outputAmount: '20875643', tradingFee: '8882687', protocolFee: '2220671' }])
  assert.deepEqual([buy.sawCanonicalSwap, buy.sawCanonicalFeeEvent], [true, true])
  // The buy's input is its whole 0.5 METAx: the fee-excluded input plus the trading and protocol fees.
  assert.equal(31979002n + 14416799n + 3604199n, 50_000_000n)
  // Rows in raw units: a buy's fee-excluded METAx in and tokens out; a sell's tokens in and METAx out.
  const [bought] = stockTradeRows(tx('buy'), 'buy-signature', buy.events), [sold] = stockTradeRows(tx('sell'), 'sell-signature', sell.events)
  assert.deepEqual([bought.signature, bought.eventIndex, bought.direction, bought.quoteAmount, bought.baseAmount, bought.trader, bought.slot],
    ['buy-signature', 0, 'buy', 31979002n, 53455273178753n, wallet, BigInt(STOCK.buy.slot)])
  assert.deepEqual([sold.direction, sold.quoteAmount, sold.baseAmount], ['sell', 20875643n, 53455273178753n])
  assert.equal(bought.tradedAt.getTime() % 1000, 0)
  assert.match(bought.nextSqrtPrice, /^[1-9]\d*$/)
})

test('the launch is matched as a known non-swap: no events, nothing unmatched', () => {
  assert.deepEqual(parse(tx('launch')), { events: [], sawCanonicalSwap: false, sawCanonicalFeeEvent: false })
})

test('the trap: the SOL parser reads a stock swap as "not a swap"; the stock parser never does', () => {
  // canonicalDbcSwapEvents requires the SOL mint as the quote, so this METAx swap is simply not seen: credited 0 with allowNonSwap.
  assert.deepEqual(canonicalDbcSwapEvents(tx('buy'), market, config, dbc), { events: [], sawCanonicalSwap: false, sawCanonicalFeeEvent: false })
  // Given the wrong quote (SOL, or another stock), the stock parser refuses: the swap names the pool with other accounts.
  for (const wrong of [NATIVE_MINT.toBase58(), QUOTE_REGISTRY.assets.find(asset => asset.symbol === 'MSFTx').mint]) {
    assert.throws(() => parse(tx('buy'), { config, quoteMint: wrong }), error => error instanceof StockEvidenceUnmatchedError &&
      /swap names the pool with other accounts/.test(error.message) && /evtSwap for the pool outside a canonical swap/.test(error.message))
  }
  assert.throws(() => parse(tx('buy'), { config: NATIVE_MINT.toBase58(), quoteMint }), StockEvidenceUnmatchedError)
  // The quote mint and config are required: nothing is assumed.
  assert.throws(() => parse(tx('buy'), { config }), /needs the market's quote mint/)
  assert.throws(() => parse(tx('buy'), { quoteMint }), /needs the market's DBC config/)
})

test('a canonical swap whose events are missing, doubled or disagree is quarantined, never credited as nothing', () => {
  const without = names => { const t = tx('buy'); const group = swapGroup(t)
    group.instructions = group.instructions.filter(instruction => !isEvent(instruction) || !names.includes(eventName(instruction))); return t }
  unmatched(without(['evtSwap', 'evtSwap2']), /canonical swap emitted 0 evtSwap and 0 evtSwap2 events/)
  // One of the two is enough, and gives the same facts and ordinal (as for SOL).
  assert.deepEqual(facts(parse(without(['evtSwap']))), facts(parse(tx('buy'))))
  assert.deepEqual(facts(parse(without(['evtSwap2']))), facts(parse(tx('buy'))))
  const doubled = tx('buy'), group = swapGroup(doubled)
  group.instructions.push(structuredClone(group.instructions.find(instruction => eventName(instruction) === 'evtSwap')))
  unmatched(doubled, /canonical swap emitted 2 evtSwap and 1 evtSwap2 events/)
  const disagree = tx('buy'), event2 = swapGroup(disagree).instructions.find(instruction => eventName(instruction) === 'evtSwap2')
  event2.data = reencoded(event2, data => { data.swapResult.tradingFee = data.swapResult.tradingFee.addn(1) })
  unmatched(disagree, /evtSwap and evtSwap2 disagree/)
  const otherConfig = tx('buy'), event1 = swapGroup(otherConfig).instructions.find(instruction => eventName(instruction) === 'evtSwap')
  event1.data = reencoded(event1, data => { data.config = new PublicKey(market.mint) })
  unmatched(otherConfig, /evtSwap names another config/)
  const direction = tx('buy'), event = swapGroup(direction).instructions.find(instruction => eventName(instruction) === 'evtSwap')
  event.data = reencoded(event, data => { data.tradeDirection = 2 })
  unmatched(direction, /unknown direction/)
  // An event CPI that does not decode is unparseable (as for SOL).
  const corrupt = tx('buy'), broken = swapGroup(corrupt).instructions.find(isEvent)
  broken.data = bs58.encode(Buffer.from(bs58.decode(broken.data)).subarray(0, 40))
  assert.throws(() => parse(corrupt), UnparseableTradeError)
  // Without recorded inner instructions a swap through another program could not be seen.
  const blind = tx('buy'); blind.meta.innerInstructions = null
  unmatched(blind, /no recorded inner instructions/)
})

test('a swap event for the pool outside a canonical swap, or an instruction on the pool it cannot match, is quarantined', () => {
  // The swap's evtSwap copied under another top-level instruction (the compute-budget one): no canonical swap emitted it.
  const stray = tx('buy'), event = swapGroup(stray).instructions.find(instruction => eventName(instruction) === 'evtSwap')
  stray.meta.innerInstructions.push({ index: 0, instructions: [{ ...structuredClone(event), stackHeight: 2 }] })
  unmatched(stray, /evtSwap for the pool outside a canonical swap/)
  const withOuter = (data, accounts) => {
    const t = tx('buy')
    t.transaction.message.instructions.push({ programIdIndex: dbcIndex(t), accounts, data: bs58.encode(Buffer.from(data)), stackHeight: 1 })
    return t
  }
  const at = (t, address) => keyIndex(t, address)
  const reference = tx('buy'), [pool, configIx, baseMint, quoteIx] = [market.pool, config, market.mint, quoteMint].map(address => at(reference, address))
  assert.ok([pool, configIx, baseMint, quoteIx].every(index => index >= 0))
  const discriminator = name => [...Buffer.from(STOCK_DBC_INSTRUCTIONS.find(entry => entry.name === name).discriminator, 'hex')]
  // An instruction the table does not know, naming the pool.
  unmatched(withOuter([1, 2, 3, 4, 5, 6, 7, 8], [pool]), /an unknown DBC instruction names the pool/)
  unmatched(withOuter([], [pool]), /an unknown DBC instruction names the pool/)
  // A swap naming the pool without inner instructions (so without an event), wherever it names it.
  const swap = discriminator('swap')
  unmatched(withOuter(swap, [0, configIx, pool, 0, 0, 0, 0, baseMint, quoteIx]), /swap on the pool has no inner instructions/)
  unmatched(withOuter(swap, [0, configIx, 0, 0, 0, 0, 0, baseMint, quoteIx, pool]), /swap on the pool has no inner instructions/)
  // The captured swap itself with another quote account, or the pool also in another place: not canonical, so quarantined.
  for (const change of [accounts => { accounts[8] = baseMint }, accounts => { accounts[12] = pool }]) {
    const t = tx('buy'), swapIx = t.transaction.message.instructions[swapGroup(t).index]
    change(swapIx.accounts)
    unmatched(t, /swap names the pool with other accounts/)
  }
  // A known non-swap: matched only with the pool, config and mints in their places.
  const claim = discriminator('claimTradingFee')
  assert.equal(parse(withOuter(claim, [0, configIx, pool, 0, 0, 0, 0, baseMint, quoteIx])).events.length, 1)
  unmatched(withOuter(claim, [0, configIx, pool, 0, 0, 0, 0, baseMint, baseMint]), /claimTradingFee names the pool with other accounts/)
  unmatched(withOuter(discriminator('claimCreatorTradingFee'), [pool]), /claimCreatorTradingFee names the pool with other accounts/)
  // Instructions that do not name the pool are not this market's (the swap is still found).
  assert.equal(parse(withOuter([1, 2, 3, 4, 5, 6, 7, 8], [configIx])).events.length, 1)
})

test('the curve\'s migration is an ERROR (graduation is indexed elsewhere), never a quarantine', () => {
  for (const name of STOCK_DBC_INSTRUCTIONS.filter(entry => entry.kind === 'migration').map(entry => entry.name)) {
    const t = tx('sell')
    t.transaction.message.instructions.push({ programIdIndex: dbcIndex(t), accounts: [keyIndex(t, market.pool)],
      data: bs58.encode(Buffer.from(STOCK_DBC_INSTRUCTIONS.find(entry => entry.name === name).discriminator, 'hex')), stackHeight: 1 })
    assert.throws(() => parse(t), error => error instanceof StockCurveMigratedError && !(error instanceof UnparseableTradeError) &&
      error.code === 'STOCK_CURVE_MIGRATED' && error.message.includes(name), name)
  }
})

test('differential: on the SOL mainnet swap2, given the SOL mint, the stock parser equals canonicalDbcSwapEvents', () => {
  const SIGNATURE = '5bMSThjxQL4LDoKnSZkZkjRLYy6ggGcaW6tr1yTZEgmjZfY3wFaqZW7rEDA7bBhjppnzVxqaVX4Y1EQjK6oMMgvc'
  const raw = JSON.parse(readFileSync(new URL('./fixtures/dbc-swap2-mainnet.json', import.meta.url)))
  const solMarket = { pool: '7r5iNAJcjLho4rCYu71D5sSbk4Hwg7uZBZoKVAXyHdc1', mint: '4axvA9WtT1xhEaofaSxaVm2KzZCco4eax2HnzJLqQdYn' }
  const solConfig = 'BePhDoh7TVPpQGNG7L5yPerN11DCXMJ3DVRQxHtgeMBV'
  const same = transaction => {
    const expected = canonicalDbcSwapEvents(transaction, solMarket, solConfig, dbc)
    assert.deepStrictEqual(stockDbcSwapEvents(transaction, solMarket, { config: solConfig, quoteMint: NATIVE_MINT }, dbc), expected)
    return expected
  }
  const tx0 = normalizeFinalizedTransaction(raw, SIGNATURE)
  assert.equal(same(tx0).events.length, 1)
  // evtSwap2 alone; the swap doubled (two trades, ordinals 0 and 1); doubled with the second swap emitting evtSwap2 only.
  const group = tx0.meta.innerInstructions.find(candidate => candidate.instructions.some(isEvent))
  const only2 = { ...tx0, meta: { ...tx0.meta, innerInstructions: tx0.meta.innerInstructions.map(candidate => ({ ...candidate,
    instructions: candidate.instructions.filter(instruction => !isEvent(instruction) || eventName(instruction) !== 'evtSwap') })) } }
  assert.equal(same(only2).events.length, 1)
  const outer = tx0.transaction.message.instructions[group.index], next = tx0.transaction.message.instructions.length
  const doubled = { ...tx0, transaction: { ...tx0.transaction, message: { ...tx0.transaction.message, instructions: [...tx0.transaction.message.instructions, outer] } },
    meta: { ...tx0.meta, innerInstructions: [...tx0.meta.innerInstructions, { ...group, index: next }] } }
  assert.deepEqual(same(doubled).events.map(event => event.eventIndex), [0, 1])
  const mixed = { ...doubled, meta: { ...doubled.meta, innerInstructions: [...tx0.meta.innerInstructions, { ...group, index: next,
    instructions: group.instructions.filter(instruction => !isEvent(instruction) || eventName(instruction) !== 'evtSwap') }] } }
  assert.deepEqual(same(mixed).events.map(event => event.eventIndex), [0, 1])
})

test('the instruction table is the program\'s IDL: discriminators, account places, and every instruction that takes a pool', () => {
  const roles = { pool: ['pool', 'virtualPool'], config: ['config'], baseMint: ['baseMint'], quoteMint: ['quoteMint'] }
  for (const entry of STOCK_DBC_INSTRUCTIONS) {
    const idl = program.idl.instructions.find(instruction => instruction.name === entry.name)
    assert.ok(idl, entry.name)
    assert.equal(Buffer.from(idl.discriminator).toString('hex'), entry.discriminator, entry.name)
    for (const [role, at] of Object.entries(entry.accounts)) assert.ok(roles[role].includes(idl.accounts[at]?.name), `${entry.name}: ${role} at ${at}`)
    if (entry.kind !== 'migration') {
      // Every account the instruction names as a pool, config or mint is in the table, so a full match checks them all.
      for (const [at, account] of idl.accounts.entries()) {
        const role = Object.keys(roles).find(candidate => roles[candidate].includes(account.name))
        if (role) assert.equal(entry.accounts[role], at, `${entry.name}: ${account.name} at ${at}`)
      }
    }
  }
  const takesPool = program.idl.instructions.filter(instruction => instruction.accounts.some(account => roles.pool.includes(account.name)))
  assert.deepEqual(takesPool.map(instruction => instruction.name).sort(), STOCK_DBC_INSTRUCTIONS.map(entry => entry.name).sort())
})

test('a migration is an ERROR, except the proven migration in its own transaction, where only a bundled swap counts', () => {
  // The real migration of DOCUSAURUS / METAx into its DAMM v2 pool (tests/stock-graduation-chain.test.mjs, mainnet's programs).
  const graduation = JSON.parse(readFileSync(new URL('./fixtures/stock-damm-graduation.json', import.meta.url), 'utf8'))
  const raw = graduation.transactions.migration, signature = raw.transaction.signatures[0]
  const migration = () => normalizeFinalizedTransaction(structuredClone(raw), signature)
  const migrated = { pool: graduation.market.curve, mint: graduation.market.mint }, options = { config: graduation.market.config, quoteMint: graduation.quoteMint }
  assert.throws(() => stockDbcSwapEvents(migration(), migrated, options, dbc), StockCurveMigratedError)
  assert.throws(() => stockDbcSwapEvents(migration(), migrated, { ...options, migrationSignature: 'another-signature' }, dbc), StockCurveMigratedError)
  assert.deepEqual(stockDbcSwapEvents(migration(), migrated, { ...options, migrationSignature: signature }, dbc).events, [])
})
