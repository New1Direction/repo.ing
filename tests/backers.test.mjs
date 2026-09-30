import test from 'node:test'
import assert from 'node:assert/strict'
import { backerPosition, summarizeBackers } from '../src/backers.mjs'

const row = (wallet, bought, sold, { spent = '1000000000', buys = 1, slot = 100, at = '2026-09-01T00:00:00Z' } = {}) =>
  ({ wallet, boughtBaseUnits: String(bought), soldBaseUnits: String(sold), spentLamports: spent, buys, firstBuySlot: String(slot), firstBuyAt: at })

test('net position is bought minus sold; only net positive wallets back the repo', () => {
  // Arrange
  const rows = [row('A', 500, 200), row('B', 100, 100, { slot: 101 }), row('C', 300, 0, { slot: 102 }), row('D', 50, 80, { slot: 103 })]
  // Act
  const summary = summarizeBackers(rows)
  // Assert
  assert.equal(summary.count, 2)
  assert.deepEqual(summary.top.map(b => [b.wallet, b.netBaseUnits]), [['A', '300'], ['C', '300']])
})

test('backers are ordered by net position, ties by earliest first buy', () => {
  const rows = [row('late', 900, 0, { slot: 300 }), row('big', 5000, 0, { slot: 400 }), row('early', 900, 0, { slot: 200 })]
  assert.deepEqual(summarizeBackers(rows).top.map(b => b.wallet), ['big', 'early', 'late'])
})

test('platform and builder wallets are disclosed with labels, never counted or ranked early', () => {
  const labels = new Map([['TEAM', { kind: 'team', label: 'repo.ing team' }], ['BUILDER', { kind: 'builder', label: 'Builder' }],
    ['FEE', { kind: 'buyback', label: 'repo.ing fee wallet' }]])
  const rows = [row('TEAM', 10_000, 0, { slot: 1 }), row('BUILDER', 7_000, 0, { slot: 2 }), row('FEE', 5, 5, { slot: 3 }), row('fan', 100, 0, { slot: 50 })]
  const summary = summarizeBackers(rows, { labels })
  assert.equal(summary.count, 1)
  assert.deepEqual(summary.top.map(b => [b.wallet, b.earlyRank]), [['fan', 1]])
  // Sold-out labelled wallets are not listed; the rest are, largest first.
  assert.deepEqual(summary.disclosed.map(d => [d.wallet, d.kind, d.label]), [['TEAM', 'team', 'repo.ing team'], ['BUILDER', 'builder', 'Builder']])
})

test('early backer ranks follow first-buy chain order and a seller keeps its slot', () => {
  // first..fourth by slot; "second" sold out, so it is not listed but still holds rank 2.
  const rows = [row('fourth', 10, 0, { slot: 40 }), row('second', 10, 10, { slot: 20 }), row('first', 10, 0, { slot: 10 }),
    row('third', 10, 0, { slot: 30, at: '2026-09-01T00:00:05Z' }), row('third-b', 10, 0, { slot: 30, at: '2026-09-01T00:00:01Z' })]
  const ranks = Object.fromEntries(summarizeBackers(rows, { early: 3 }).top.map(b => [b.wallet, b.earlyRank]))
  assert.deepEqual(ranks, { first: 1, 'third-b': 3, third: null, fourth: null })
})

test('top is capped at limit while count covers every backer', () => {
  const rows = Array.from({ length: 14 }, (_, i) => row(`w${String(i).padStart(2, '0')}`, 100 + i, 0, { slot: i }))
  const summary = summarizeBackers(rows, { limit: 10 })
  assert.equal(summary.count, 14)
  assert.equal(summary.top.length, 10)
  assert.equal(summary.top[0].wallet, 'w13')
})

test('wallets with no indexed buy and malformed rows are ignored', () => {
  const rows = [{ wallet: 'X', boughtBaseUnits: 'nope', soldBaseUnits: '0', spentLamports: '0', buys: 1 }, row('seller-only', 0, 50, { buys: 0 }),
    null, row('ok', 1, 0)]
  const summary = summarizeBackers(rows)
  assert.deepEqual(summary.top.map(b => b.wallet), ['ok'])
  assert.equal(backerPosition({ wallet: '', boughtBaseUnits: '1', soldBaseUnits: '0', spentLamports: '0' }), null)
})

test('amounts stay exact past Number precision and serialize as strings', () => {
  const huge = 10n ** 24n + 7n
  const [top] = summarizeBackers([row('whale', huge, 7, { spent: String(10n ** 20n) })]).top
  assert.equal(top.netBaseUnits, String(10n ** 24n))
  assert.equal(top.spentLamports, String(10n ** 20n))
  assert.equal(top.firstBuyAt, '2026-09-01T00:00:00.000Z')
})

test('empty market: no backers, empty lists', () => {
  assert.deepEqual(summarizeBackers([]), { count: 0, top: [], disclosed: [], early: 10 })
})
