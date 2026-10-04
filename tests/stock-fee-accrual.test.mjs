import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { UnparseableTradeError } from '../src/trade-evidence.mjs'
import { StockCurveMigratedError } from '../src/stock-trade-evidence.mjs'
import { assertStockCurveConfig, createStockFeeAccrual, stockFeeSplit } from '../src/stock-fee-accrual.mjs'
import { LAUNCHER_DEN, LAUNCHER_NUM, POLICY_VERSION, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { dustSwap } from './fixtures/dbc-stock-dust.mjs'

// Curve fee accrual for a stock pair (docs/STOCK_QUOTES.md) on the DOCUSAURUS / METAx buy and sell captured from the local
// stock-pair validator, with an in-memory database and the pool and config as the chain held them.
const STOCK = JSON.parse(readFileSync(new URL('./fixtures/dbc-stock-swaps-local.json', import.meta.url)))
const META = quoteAssetById('meta-xstock')
const real = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'finalized')
const signatureOf = name => STOCK[name].transaction.signatures[0]
const [BUY, SELL, LAUNCH] = ['buy', 'sell', 'launch'].map(signatureOf)
// The dust swaps mainnet's DBC program accepts (fixtures/dbc-stock-dust.mjs), made from the captured buy and sell.
const [DUST_BUY, DUST_SELL] = ['dust-buy-signature', 'dust-sell-signature']
const transactions = new Map([...['buy', 'sell', 'launch'].map(name => [signatureOf(name), STOCK[name]]),
  [DUST_BUY, dustSwap(STOCK.buy, real.state.getProgram(), 'buy', DUST_BUY)], [DUST_SELL, dustSwap(STOCK.sell, real.state.getProgram(), 'sell', DUST_SELL)]])
const creator = Keypair.generate().publicKey
const MARKET = { repoId: '94911145', status: 'confirmed', mint: STOCK.market.mint, pool: STOCK.market.pool, creatorWallet: creator.toBase58(),
  launchFinality: 'finalized', indexedAt: new Date(), quoteAssetId: META.assetId, quoteMint: META.mint }
const FIXED = { quoteMint: new PublicKey(META.mint), quoteTokenFlag: 1, collectFeeMode: 0, creatorTradingFeePercentage: 71 }
const poolState = (changes = {}) => ({ config: new PublicKey(STOCK.market.config), baseMint: new PublicKey(STOCK.market.mint), creator,
  isMigrated: 0, creatorQuoteFee: new BN(1), partnerQuoteFee: new BN(2), ...changes })

// Just enough PostgreSQL: the market, the advisory lock, one transaction, and the two ledgers keyed by (signature, event_index).
function fakeDatabase({ market = MARKET, failTradeInsert = false } = {}) {
  const state = { queries: [], fees: new Map(), trades: new Map(), staged: null }
  const textRow = (fields, values) => Object.fromEntries(fields.map((field, i) => [field, values[i]]))
  const query = async (sql, params = []) => {
    state.queries.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
    if (/advisory/.test(sql)) return { rows: [{ locked: true }] }
    if (/^set local lock_timeout = \d+$/.test(sql)) { state.lockTimeouts = [...(state.lockTimeouts ?? []), Number(sql.split('= ')[1])]; return { rows: [] } }
    if (/from markets where github_repo_id/.test(sql)) return { rows: market ? [market] : [] }
    if (sql === 'begin') { state.staged = { fees: new Map(state.fees), trades: new Map(state.trades) }; return { rows: [] } }
    if (sql === 'commit') { Object.assign(state, state.staged, { staged: null }); return { rows: [] } }
    if (sql === 'rollback') { state.staged = null; return { rows: [] } }
    const insert = /^insert into (stock_fee_events|stock_trade_events) \(([^)]+)\)/.exec(sql)
    if (insert) {
      const fields = insert[2].split(', '), ledger = insert[1] === 'stock_fee_events' ? 'fees' : 'trades'
      if (ledger === 'trades' && failTradeInsert) throw Error('stock_trade_events refused the row')
      const key = `${params[fields.indexOf('signature')]}:${params[fields.indexOf('event_index')]}`
      if (state.staged[ledger].has(key)) return { rows: [], rowCount: 0 }
      state.staged[ledger].set(key, textRow(fields, params))
      return { rows: [], rowCount: 1 }
    }
    const stored = /from (stock_fee_events|stock_trade_events) where signature = \$1 and event_index = \$2/.exec(sql)
    if (stored) return { rows: [state.staged[stored[1] === 'stock_fee_events' ? 'fees' : 'trades'].get(`${params[0]}:${params[1]}`)].filter(Boolean) }
    throw Error(`Unexpected SQL in fake database: ${sql}`)
  }
  return { state, query, connect: async () => ({ query, release() {} }) }
}
// The queries after the market's lock: the lock is taken in a short transaction of its own (begin, set local lock_timeout,
// pg_advisory_lock, commit), so whether anything was written is read from what follows it.
const afterLock = db => db.state.queries.slice(db.state.queries.indexOf('commit') + 1)
let endpoints = 0
function accrualFor(db, { state = poolState(), fixed = FIXED, configs = new Map([[META.assetId, new PublicKey(STOCK.market.config)]]) } = {}) {
  // A distinct endpoint per accrual: readPoolConfig keeps decoded configs per endpoint.
  const dbc = { connection: { rpcEndpoint: `fake-${++endpoints}` }, commitment: 'finalized',
    state: { getProgram: () => real.state.getProgram(), getPool: async () => state && { poolState: state }, getPoolConfig: async () => fixed } }
  return createStockFeeAccrual({ pool: db, connection: dbc.connection, config: Keypair.generate().publicKey.toBase58(), stockConfigs: configs, dbc,
    loadTransaction: async (_connection, signature) => normalizeFinalizedTransaction(structuredClone(transactions.get(signature)), signature) })
}

test('policy use: each swap\'s fee is the program\'s creator/partner split, then the stock fee policy\'s launcher/accumulator split', () => {
  assert.deepEqual([LAUNCHER_NUM, LAUNCHER_DEN, POLICY_VERSION], [150n, 497n, 1])
  for (const fee of [0n, 1n, 2n, 99n, 100n, 101n, 8882687n, 14416799n, 10n ** 18n]) {
    const split = stockFeeSplit({ tradingFee: new BN(fee.toString()), creatorPercentage: 71 })
    const creatorAmount = fee * 71n / 100n, partnerAmount = fee - creatorAmount
    assert.deepEqual(split, { creatorAmount, partnerAmount, ...splitCurveFee({ creatorAmount, partnerAmount }), policyVersion: POLICY_VERSION })
    assert.equal(split.launcherAmount, creatorAmount * 150n / 497n)
    assert.equal(split.launcherAmount + split.accumulatorAmount, fee)
  }
  // The captured buy: 14416799 raw METAx of trading fee.
  assert.deepEqual(stockFeeSplit({ tradingFee: new BN(14416799), creatorPercentage: 71 }),
    { creatorAmount: 10235927n, partnerAmount: 4180872n, launcherAmount: 3089313n, accumulatorAmount: 11327486n, policyVersion: 1 })
})

test('the stock config must quote the market\'s stock through Token-2022, collect fees in it, and give the creator 71%', () => {
  assert.ok(assertStockCurveConfig(FIXED, META))
  assert.throws(() => assertStockCurveConfig({ ...FIXED, quoteMint: new PublicKey(quoteAssetById('msft-xstock').mint) }, META), /does not quote the market's stock/)
  assert.throws(() => assertStockCurveConfig({ ...FIXED, quoteTokenFlag: 0 }, META), /through Token-2022/)
  assert.throws(() => assertStockCurveConfig({ ...FIXED, collectFeeMode: 1 }, META), /collect fees in the stock/)
  assert.throws(() => assertStockCurveConfig({ ...FIXED, creatorTradingFeePercentage: 70 }, META), error => error.code === 'STOCK_POLICY_CONFIG_MISMATCH')
  assert.throws(() => assertStockCurveConfig(null, META), /config is missing/)
})

test('a buy and a sell become one fee row and one trade row each, written in one transaction', async () => {
  const db = fakeDatabase()
  const result = await accrualFor(db).recordTradeFees({ githubRepoId: '94911145', signatures: [BUY, SELL], quoteMint: META.mint })
  // The market's lock is taken with a bounded wait (src/stock-fee-accrual.mjs, STOCK_FEE_LOCK_TIMEOUT_MS), then held as before.
  assert.deepEqual(db.state.queries, ['begin', 'set local lock_timeout', 'select pg_advisory_lock($1::bigint)', 'commit', 'select github_repo_id::text as', 'begin',
    'insert into stock_fee_events', 'insert into stock_fee_events', 'insert into stock_trade_events', 'insert into stock_trade_events', 'commit',
    'select pg_advisory_unlock($1::bigint)'])
  assert.deepEqual(db.state.lockTimeouts, [10_000])
  const buyFee = db.state.fees.get(`${BUY}:0`), sellFee = db.state.fees.get(`${SELL}:0`)
  assert.deepEqual(buyFee, { github_repo_id: '94911145', asset_id: 'meta-xstock', quote_mint: META.mint, pool: STOCK.market.pool, signature: BUY,
    event_index: '0', slot: String(STOCK.buy.slot), creator_amount: '10235927', partner_amount: '4180872', launcher_amount: '3089313',
    accumulator_amount: '11327486', policy_version: '1' })
  const sell = stockFeeSplit({ tradingFee: new BN(8882687), creatorPercentage: 71 })
  assert.deepEqual([sellFee.creator_amount, sellFee.partner_amount, sellFee.launcher_amount, sellFee.accumulator_amount],
    [sell.creatorAmount, sell.partnerAmount, sell.launcherAmount, sell.accumulatorAmount].map(String))
  const wallet = STOCK.buy.transaction.message.accountKeys[0]
  assert.deepEqual(db.state.trades.get(`${BUY}:0`), { github_repo_id: '94911145', asset_id: 'meta-xstock', quote_mint: META.mint, venue: 'dbc',
    pool: STOCK.market.pool, signature: BUY, event_index: '0', slot: String(STOCK.buy.slot), traded_at: new Date(1791129998000).toISOString(),
    direction: 'buy', quote_amount: '31979002', base_amount: '53455273178753', next_sqrt_price: '14691977802934805', trader: wallet })
  assert.deepEqual([db.state.trades.get(`${SELL}:0`).direction, db.state.trades.get(`${SELL}:0`).quote_amount], ['sell', '20875643'])
  assert.deepEqual(result, { githubRepoId: 94911145n, assetId: 'meta-xstock', quoteMint: META.mint,
    creditedBaseUnits: 10235927n + sell.creatorAmount, creditedPartnerUnits: 4180872n + sell.partnerAmount,
    observedCreatorFee: 1n, observedPartnerFee: 2n, eventKeys: [`${BUY}:0`, `${SELL}:0`] })
})

test('a dust swap that moves nothing out is a trade row with its zero amounts, and its fee is credited', async () => {
  // 1 raw METAx in, all of it the fee (creator 71% of 1 rounds to 0, the partner gets 1); 1 raw token in, nothing out, no fee.
  const db = fakeDatabase()
  const result = await accrualFor(db).recordTradeFees({ githubRepoId: '94911145', signatures: [DUST_BUY, DUST_SELL] })
  assert.deepEqual([result.creditedBaseUnits, result.creditedPartnerUnits, result.eventKeys], [0n, 1n, [`${DUST_BUY}:0`, `${DUST_SELL}:0`]])
  const fee = signature => ['creator_amount', 'partner_amount', 'launcher_amount', 'accumulator_amount'].map(field => db.state.fees.get(`${signature}:0`)[field])
  assert.deepEqual([fee(DUST_BUY), fee(DUST_SELL)], [['0', '1', '0', '1'], ['0', '0', '0', '0']])
  const trade = signature => ['direction', 'quote_amount', 'base_amount'].map(field => db.state.trades.get(`${signature}:0`)[field])
  assert.deepEqual([trade(DUST_BUY), trade(DUST_SELL)], [['buy', '0', '0'], ['sell', '0', '1']])
})

test('the same evidence again credits nothing; stored rows that contradict the chain stop the market', async () => {
  const db = fakeDatabase(), accrual = accrualFor(db)
  await accrual.recordTradeFees({ githubRepoId: '94911145', signatures: [BUY] })
  const again = await accrual.recordTradeFees({ githubRepoId: '94911145', signatures: [BUY, BUY] })
  assert.deepEqual([again.creditedBaseUnits, again.creditedPartnerUnits, again.eventKeys], [0n, 0n, [`${BUY}:0`]])
  assert.equal(db.state.fees.size, 1)
  // A fee row split under an earlier policy keeps its split; the chain's own amounts must still agree.
  db.state.fees.set(`${BUY}:0`, { ...db.state.fees.get(`${BUY}:0`), launcher_amount: '0', accumulator_amount: '14416799', policy_version: '0' })
  assert.equal((await accrual.recordTradeFees({ githubRepoId: '94911145', signatures: [BUY] })).creditedBaseUnits, 0n)
  for (const [ledger, field, value] of [['fees', 'creator_amount', '10235928'], ['fees', 'slot', '1'], ['trades', 'quote_amount', '1'], ['trades', 'trader', null]]) {
    const saved = db.state[ledger].get(`${BUY}:0`)
    db.state[ledger].set(`${BUY}:0`, { ...saved, [field]: value })
    await assert.rejects(accrual.recordTradeFees({ githubRepoId: '94911145', signatures: [BUY] }), /contradicts finalized chain evidence/)
    assert.equal(db.state.queries.at(-2), 'rollback')
    db.state[ledger].set(`${BUY}:0`, saved)
  }
})

test('a trade row that cannot be written rolls the fee row back with it', async () => {
  const db = fakeDatabase({ failTradeInsert: true })
  await assert.rejects(accrualFor(db).recordTradeFees({ githubRepoId: '94911145', signatures: [BUY] }), /refused the row/)
  assert.deepEqual([db.state.fees.size, db.state.trades.size, afterLock(db).includes('commit'), db.state.queries.at(-2)], [0, 0, false, 'rollback'])
})

test('a transaction with no swap is credited only by the indexer, which passes every pool transaction', async () => {
  const db = fakeDatabase()
  await assert.rejects(accrualFor(db).recordTradeFees({ githubRepoId: '94911145', signatures: [LAUNCH] }), UnparseableTradeError)
  const launch = await accrualFor(db).recordTradeFees({ githubRepoId: '94911145', signatures: [LAUNCH], allowNonSwap: true })
  assert.deepEqual([launch.creditedBaseUnits, launch.eventKeys, db.state.fees.size, db.state.trades.size], [0n, [], 0, 0])
})

test('anything that is not this stock market\'s live curve is an error before any evidence is read or written', async () => {
  const cases = [
    [{ market: null }, {}, /no indexed stock-paired market/],
    [{ market: { ...MARKET, quoteAssetId: null, quoteMint: null } }, {}, /not stock-paired/],
    [{ market: { ...MARKET, indexedAt: null } }, {}, /no indexed stock-paired market/],
    [{ market: { ...MARKET, quoteMint: quoteAssetById('msft-xstock').mint } }, {}, /mint differs from its registry asset/],
    [{}, { configs: new Map() }, /no registered config/],
    [{}, { state: null }, /pool is missing/],
    [{}, { state: poolState({ creator: Keypair.generate().publicKey }) }, /pool state does not match market/],
    [{}, { state: poolState({ isMigrated: 1 }) }, StockCurveMigratedError],
    [{}, { fixed: { ...FIXED, creatorTradingFeePercentage: 50 } }, /creator share/],
  ]
  for (const [database, chain, expected] of cases) {
    const db = fakeDatabase(database)
    await assert.rejects(accrualFor(db, chain).recordTradeFees({ githubRepoId: '94911145', signatures: [BUY] }), expected)
    assert.ok(!afterLock(db).includes('begin'), `nothing written: ${expected}`)
  }
  const db = fakeDatabase()
  await assert.rejects(accrualFor(db).recordTradeFees({ githubRepoId: '94911145', signatures: [BUY], quoteMint: quoteAssetById('nvda-xstock').mint }),
    /quote mint differs from the market's stock/)
  await assert.rejects(accrualFor(db).recordTradeFees({ githubRepoId: '94911145', signatures: [] }), /signatures required/)
  // checkCurve is the same check, for the indexer to run before it reads any history.
  await assert.rejects(accrualFor(db, { state: poolState({ isMigrated: 1 }) }).checkCurve('94911145'), StockCurveMigratedError)
  assert.equal((await accrualFor(db).checkCurve('94911145')).asset, META)
})

test('a migrated curve, with its proven migration, credits only the swaps finalized up to and in it', async () => {
  // As the indexer finishes a graduated curve (src/stock-fee-indexer.mjs): the migration proven by src/stock-graduation-monitor.mjs.
  // Here the sell stands in for the migration transaction: a swap bundled into it is credited like any before it.
  const migrated = { state: poolState({ isMigrated: 1 }) }, migration = { signature: SELL, slot: String(STOCK.sell.slot) }
  const db = fakeDatabase()
  await assert.rejects(accrualFor(db, migrated).recordTradeFees({ githubRepoId: '94911145', signatures: [BUY] }), StockCurveMigratedError)
  const before = await accrualFor(db, migrated).recordTradeFees({ githubRepoId: '94911145', signatures: [BUY], migration })
  assert.deepEqual([before.creditedBaseUnits, before.eventKeys], [10235927n, [`${BUY}:0`]])
  const bundled = await accrualFor(db, migrated).recordTradeFees({ githubRepoId: '94911145', signatures: [SELL], migration })
  assert.deepEqual(bundled.eventKeys, [`${SELL}:0`])
  // Anything finalized after the migration's slot is never credited here.
  await assert.rejects(accrualFor(db, migrated).recordTradeFees({ githubRepoId: '94911145', signatures: [SELL],
    migration: { signature: BUY, slot: String(STOCK.buy.slot) } }), StockCurveMigratedError)
  assert.deepEqual([db.state.fees.size, db.state.trades.size], [2, 2])
  assert.equal((await accrualFor(db, migrated).checkCurve('94911145', db, migration)).migration, migration)
})
