import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Connection } from '@solana/web3.js'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { dammSwapEvents } from '../src/damm-trades.mjs'
import { canonicalTradeEvents } from '../src/trade-evidence.mjs'
import { swapTrader } from '../src/swap-trader.mjs'
import { backfillTraders, retrying } from '../src/trader-backfill.mjs'
import { averageCost, holdingPnl, walletTrades, withHoldingPnl } from '../app/lib/holding-pnl.mjs'

// Real finalized mainnet swaps; no RPC is touched.
const damm = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const dbcRaw = JSON.parse(readFileSync(new URL('./fixtures/dbc-swap2-mainnet.json', import.meta.url), 'utf8'))
const load = raw => normalizeFinalizedTransaction(structuredClone(raw), raw.transaction.signatures[0])
const dammCoder = new CpAmm(new Connection('http://127.0.0.1:8909'))._program.coder
const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'finalized')
const REPOING = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const dbcMarket = { pool: '7r5iNAJcjLho4rCYu71D5sSbk4Hwg7uZBZoKVAXyHdc1', mint: '4axvA9WtT1xhEaofaSxaVm2KzZCco4eax2HnzJLqQdYn',
  signature: dbcRaw.transaction.signatures[0] }
const dbcConfig = 'BePhDoh7TVPpQGNG7L5yPerN11DCXMJ3DVRQxHtgeMBV'
const feePayer = raw => raw.transaction.message.accountKeys[0]

test('DAMM trader is the signing swap payer, on a legacy buy and a v0 sell with lookup-table accounts', () => {
  const buy = dammSwapEvents(load(damm.buy), { mint: REPOING }, damm.pool, dammCoder)
  assert.equal(buy.length, 1)
  assert.equal(buy[0].direction, 'buy')
  assert.equal(buy[0].trader, feePayer(damm.buy))
  assert.ok(BigInt(buy[0].baseAmount) > 0n)
  assert.equal(damm.sell.version, 0)
  assert.ok(damm.sell.meta.loadedAddresses.readonly.length > 0)
  const sell = dammSwapEvents(load(damm.sell), { mint: REPOING }, damm.pool, dammCoder)
  assert.equal(sell.length, 1)
  assert.equal(sell[0].direction, 'sell')
  assert.equal(sell[0].trader, feePayer(damm.sell))
  assert.ok(BigInt(sell[0].baseAmount) > 0n)
})

test('DBC trader is the signing swap payer on a real v0 swap2', () => {
  const [event] = canonicalTradeEvents(load(dbcRaw), dbcMarket, dbcConfig, dbc)
  assert.equal(event.direction, 'sell')
  assert.equal(event.trader, feePayer(dbcRaw))
})

test('a non-signing swap authority (aggregator route) is attributed to the fee payer', () => {
  const tx = load(damm.sell), keys = tx.transaction.message.accountKeys
  const instruction = { accounts: [0, 0, 0, 0, 0, 0, 0, 0, 5] }
  assert.ok(5 >= tx.transaction.message.header.numRequiredSignatures)
  assert.equal(swapTrader(tx, instruction, 8), keys[0].toBase58())
  // Same real transaction with its swap payer re-pointed at a program-owned (non-signer) account.
  const raw = structuredClone(damm.sell), swap = raw.transaction.message.instructions[4]
  swap.accounts = swap.accounts.with(8, 13)
  const [event] = dammSwapEvents(normalizeFinalizedTransaction(raw, raw.transaction.signatures[0]), { mint: REPOING }, damm.pool, dammCoder)
  assert.equal(event.trader, feePayer(damm.sell))
  assert.equal(swapTrader(tx, { accounts: [] }, 8), keys[0].toBase58())
})

const buy = (tokens, lamports) => ({ direction: 'buy', tokens: String(tokens), lamports: String(lamports) })
const sell = (tokens, lamports) => ({ direction: 'sell', tokens: String(tokens), lamports: String(lamports) })

test('average cost carries through partial sells and books realized P&L on the sold share', () => {
  // 100 tokens for 1000, 100 for 3000 → average 20/token. Sell 50 for 1500 → realized 1500 − 1000 = 500.
  const state = averageCost([buy(100, 1000), buy(100, 3000), sell(50, 1500)])
  assert.deepEqual(state, { buys: 2, covered: 150n, cost: 3000n, realized: 500n, uncoveredSold: 0n })
  // Selling the rest at a loss releases the remaining cost: realized 500 + (1500 − 3000).
  assert.equal(averageCost([buy(100, 1000), buy(100, 3000), sell(50, 1500), sell(150, 1500)]).realized, -1000n)
})

test('P&L reports cost basis, unrealized SOL and percent, and realized separately', () => {
  const trades = [buy(2_000_000, 1_000_000_000), sell(1_000_000, 800_000_000)] // 2 tokens for 1 SOL, sell 1 for 0.8
  const pnl = holdingPnl(trades, '1000000', 0.7) // 1 token left at 0.7 SOL
  assert.deepEqual(pnl, { costBasisLamports: '500000000', coveredBaseUnits: '1000000', uncoveredBaseUnits: '0', partial: false,
    unrealizedLamports: '200000000', unrealizedPercent: 40, realizedLamports: '300000000' })
  const loss = holdingPnl(trades, '1000000', 0.25)
  assert.equal(loss.unrealizedLamports, '-250000000')
  assert.equal(loss.unrealizedPercent, -50)
  assert.equal(holdingPnl(trades, '1000000', null).unrealizedLamports, null)
})

test('tokens beyond indexed buys are partial and never counted as free profit', () => {
  // Bought 1 token for 1 SOL; wallet now holds 3 (2 arrived by transfer). Price 2 SOL.
  const pnl = holdingPnl([buy(1_000_000, 1_000_000_000)], '3000000', 2)
  assert.equal(pnl.partial, true)
  assert.equal(pnl.coveredBaseUnits, '1000000')
  assert.equal(pnl.uncoveredBaseUnits, '2000000')
  assert.equal(pnl.costBasisLamports, '1000000000')
  assert.equal(pnl.unrealizedLamports, '1000000000') // only the covered token, not 5 SOL
  // Selling more than was bought books realized P&L only on the covered part.
  const oversold = averageCost([buy(1_000_000, 1_000_000_000), sell(3_000_000, 6_000_000_000)])
  assert.equal(oversold.realized, 1_000_000_000n)
  assert.equal(oversold.uncoveredSold, 2_000_000n)
  assert.equal(holdingPnl([buy(1_000_000, 1_000_000_000), sell(3_000_000, 6_000_000_000)], '500000', 1).partial, true)
})

test('tokens sent away without a sell keep the average cost on what is still held', () => {
  const pnl = holdingPnl([buy(4_000_000, 4_000_000_000)], '1000000', 1)
  assert.deepEqual([pnl.costBasisLamports, pnl.unrealizedLamports, pnl.partial], ['1000000000', '0', false])
})

test('no indexed trades or no indexed buys produce no P&L row', () => {
  assert.equal(holdingPnl([], '1000000', 1), null)
  assert.equal(holdingPnl(undefined, '1000000', 1), null)
  assert.equal(holdingPnl([sell(1_000_000, 5)], '1000000', 1), null)
  const [held, empty] = withHoldingPnl([{ repoId: '1', balanceBaseUnits: '5' }, { repoId: '2', balanceBaseUnits: '0' }], new Map())
  assert.equal(held.pnl, null)
  assert.equal('pnl' in empty, false)
})

test('wallet trades load every market in one batched query, grouped per repository in chain order', async () => {
  const calls = []
  const db = { query: async (sql, params) => { calls.push({ sql, params })
    return { rows: [{ repoId: '1', direction: 'buy', tokens: '5', lamports: '9' }, { repoId: '2', direction: 'buy', tokens: '1', lamports: '1' },
      { repoId: '1', direction: 'sell', tokens: '2', lamports: '4' }] } } }
  const grouped = await walletTrades(db, 'W', [{ repoId: '1', pool: 'P1' }, { repoId: '2', pool: 'P2' }])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params, ['W', ['1', '2'], ['P1', 'P2']])
  assert.match(calls[0].sql, /t\.trader = \$1/)
  assert.match(calls[0].sql, /d\.trader = \$1/)
  assert.deepEqual(grouped.get('1').map(r => r.direction), ['buy', 'sell'])
  assert.equal((await walletTrades(db, 'W', [])).size, 0)
  assert.equal(calls.length, 1)
})

test('backfill fills only matching rows, writes nothing on dry run, and resumes by row id', async () => {
  const sig = damm.sell.transaction.signatures[0]
  const [event] = dammSwapEvents(load(damm.sell), { mint: REPOING }, damm.pool, dammCoder)
  const rows = [{ id: 7, signature: sig, event_index: event.eventIndex, direction: 'sell', quote: event.quoteAmount, pool: damm.pool, mint: REPOING, trader: null, base_amount: null },
    { id: 9, signature: sig, event_index: 99, direction: 'sell', quote: '1', pool: damm.pool, mint: REPOING, trader: null, base_amount: null }]
  const writes = []
  const db = { query: async (sql, params) => {
    if (/^update/.test(sql)) { writes.push(params); return { rowCount: 1 } }
    if (/^(begin|commit|rollback)/.test(sql)) return {}
    if (/from trade_events where/.test(sql)) return { rows: [] }
    if (/group by signature/.test(sql)) return { rows: params[0] < 7 ? [{ signature: sig, id: 7 }] : [] }
    return { rows }
  } }
  const parse = { damm: (tx, market, pool) => dammSwapEvents(tx, market, pool, dammCoder), dbc: () => [] }
  const run = dryRun => backfillTraders({ db, parse, dryRun, delayMs: 0, loadTransaction: async () => load(damm.sell) })
  const dry = await run(true)
  assert.deepEqual([dry.rows, dry.mismatched, dry.failed, writes.length], [1, 1, 0, 0])
  const applied = await run(false)
  assert.equal(applied.rows, 1)
  assert.deepEqual(writes, [[7, feePayer(damm.sell), event.baseAmount]])
  assert.equal(applied.cursor.damm, 7)
  const resumed = await backfillTraders({ db, parse, dryRun: false, delayMs: 0, afterId: { dbc: 0, damm: 7 }, loadTransaction: async () => load(damm.sell) })
  assert.equal(resumed.signatures, 0)
})

test('backfill RPC reads retry rate limits with backoff but not permanent errors', async () => {
  const waits = [], sleep = async ms => { waits.push(ms) }
  let calls = 0
  const flaky = retrying(async () => { if (++calls < 3) throw Error('Solana RPC transaction read returned HTTP 429'); return 'tx' }, { sleep, baseMs: 10 })
  assert.equal(await flaky('sig'), 'tx')
  assert.deepEqual(waits, [10, 20])
  const broken = retrying(async () => { calls++; throw Error('Finalized transaction has an unsupported or incomplete RPC shape') }, { sleep })
  calls = 0
  await assert.rejects(broken('sig'), /unsupported/)
  assert.equal(calls, 1)
})
