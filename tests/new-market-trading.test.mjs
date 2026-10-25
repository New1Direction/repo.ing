import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNewMarketTrade, newMarketControls } from '../src/new-market-trading.mjs'

const SOL = 1_000_000_000n
const reviewed = ['111', '222']
// Answers the two queries the module makes: the control row and the rolling 24 h sum of submitted new-market buys.
function fakeDb({ row = { enabled: true, max_buy_lamports: String(SOL), daily_buy_lamports: String(3n * SOL) }, spent = 0n, fail = false } = {}) {
  const calls = []
  return { calls, async query(sql, params) {
    calls.push({ sql, params })
    if (fail) throw Error('connection refused')
    if (/from trading_controls/.test(sql)) return { rows: row ? [row] : [] }
    if (/from trade_outcomes/.test(sql)) return { rows: [{ spent: String(spent) }] }
    throw Error('unexpected query')
  } }
}

test('no control row, a database error or a disabled row all mean new-market buys are off', async () => {
  assert.deepEqual(await newMarketControls(fakeDb({ row: null })), { enabled: false })
  assert.deepEqual(await newMarketControls(fakeDb({ fail: true })), { enabled: false })
  assert.equal((await newMarketControls(fakeDb({ row: { enabled: false, max_buy_lamports: '1', daily_buy_lamports: '1' } }))).enabled, false)
  await assert.rejects(assertNewMarketTrade(fakeDb({ row: null }), { direction: 'buy', amountLamports: 1n, reviewedRepoIds: reviewed }),
    /New-market trading is paused/)
})

test('the kill switch stops buys immediately, without a redeploy; holders can always sell', async () => {
  const off = fakeDb({ row: { enabled: false, max_buy_lamports: String(SOL), daily_buy_lamports: String(3n * SOL) } })
  await assert.rejects(assertNewMarketTrade(off, { direction: 'buy', amountLamports: 1n, reviewedRepoIds: reviewed }), /paused/)
  for (const db of [off, fakeDb({ row: null }), fakeDb({ fail: true })]) {
    db.calls.length = 0
    await assertNewMarketTrade(db, { direction: 'sell', amountLamports: 5n * SOL, reviewedRepoIds: reviewed })
    assert.equal(db.calls.length, 0, 'a sell never depends on the switch or a database read')
  }
})

test('a buy above the per-trade cap is refused; sells are never capped', async () => {
  await assert.rejects(assertNewMarketTrade(fakeDb(), { direction: 'buy', amountLamports: SOL + 1n, reviewedRepoIds: reviewed }),
    /New-market trading limit: a buy can be at most 1 SOL/)
  await assertNewMarketTrade(fakeDb(), { direction: 'buy', amountLamports: SOL, reviewedRepoIds: reviewed })
  await assertNewMarketTrade(fakeDb(), { direction: 'sell', amountLamports: 100n * SOL, reviewedRepoIds: reviewed })
})

test('the rolling 24 h buy total excludes reviewed existing markets and refuses the buy that would pass the daily cap', async () => {
  const db = fakeDb({ spent: 2n * SOL + 1n })
  await assert.rejects(assertNewMarketTrade(db, { direction: 'buy', amountLamports: SOL, reviewedRepoIds: reviewed }),
    /New-market trading limit: today's new-market buys are full/)
  const sum = db.calls.find(c => /from trade_outcomes/.test(c.sql))
  assert.match(sum.sql, /outcome = 'submitted'/)
  assert.match(sum.sql, /direction = 'buy'/)
  assert.match(sum.sql, /interval '24 hours'/)
  assert.deepEqual(sum.params, [reviewed])
  await assertNewMarketTrade(fakeDb({ spent: 2n * SOL }), { direction: 'buy', amountLamports: SOL, reviewedRepoIds: reviewed })
})

test('invalid amounts and directions are refused before any database read', async () => {
  for (const args of [{ direction: 'buy', amountLamports: 0n }, { direction: 'buy', amountLamports: -1n },
    { direction: 'buy', amountLamports: 'abc' }, { direction: 'swap', amountLamports: 1n }]) {
    const db = fakeDb()
    await assert.rejects(assertNewMarketTrade(db, { ...args, reviewedRepoIds: reviewed }), /Invalid trade/)
    assert.equal(db.calls.length, 0)
  }
})
