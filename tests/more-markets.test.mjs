import test from 'node:test'
import assert from 'node:assert/strict'
import { MORE_MARKETS_LIMIT, NEW_MARKET_MS, selectMoreMarkets } from '../app/lib/more-markets.mjs'

const now = Date.UTC(2026, 8, 29)
const day = 86_400_000
const market = (id, volume, ageMs) => ({ repoId: String(id), mint: `mint${id}`, fullName: `o/r${id}`, symbol: `S${id}`, volume24hLamports: String(volume),
  indexedAt: new Date(now - ageMs), pool: `pool${id}`, description: 'unused' })

test('more markets: excludes current and official mints, volume first then newest, max 8', () => {
  const markets = [market(1, 0, 1 * day), market(2, 500, 30 * day), market(3, 0, 3 * day), market(4, 900, 40 * day),
    market(5, 0, 2 * day), market(6, 0, 50 * day), market(7, 0, 60 * day), market(8, 0, 70 * day), market(9, 0, 80 * day),
    market(10, 0, 90 * day), market(11, 5000, 0), market(12, 0, 100 * day)]
  const picked = selectMoreMarkets(markets, { excludeMints: ['mint11', 'mint12'], now })
  assert.equal(picked.length, MORE_MARKETS_LIMIT)
  assert.deepEqual(picked.map(m => m.mint), ['mint4', 'mint2', 'mint1', 'mint5', 'mint3', 'mint6', 'mint7', 'mint8'])
  assert.deepEqual(Object.keys(picked[0]).sort(), ['fullName', 'isNew', 'mint', 'repoId', 'symbol', 'volume24hLamports'])
})

test('more markets: New flag holds strictly inside 7 days', () => {
  const [inside, boundary, outside] = selectMoreMarkets([market(1, 3, NEW_MARKET_MS - 1), market(2, 2, NEW_MARKET_MS), market(3, 1, NEW_MARKET_MS + 1)], { now })
  assert.equal(inside.isNew, true)
  assert.equal(boundary.isNew, false)
  assert.equal(outside.isNew, false)
})

test('more markets: empty when only excluded markets exist', () => {
  assert.deepEqual(selectMoreMarkets([market(1, 1, 0)], { excludeMints: ['mint1'], now }), [])
  assert.deepEqual(selectMoreMarkets([], { now }), [])
})
