import test from 'node:test'
import assert from 'node:assert/strict'
import { ttlMemo } from '../app/lib/ttl-memo.mjs'

test('ttl memo shares one in-flight load, expires, and never keeps unavailable or rejected results', async () => {
  let now = 0, loads = 0, release
  const memo = ttlMemo(() => { loads++; return new Promise(resolve => { release = resolve }) }, 15_000, { keep: value => value.ok, clock: () => now })
  const [a, b] = [memo(), memo()]
  release({ ok: true, n: 1 })
  assert.equal(await a, await b); assert.equal(loads, 1)
  now = 14_999; assert.equal((await memo()).n, 1); assert.equal(loads, 1)
  now = 15_000; const next = memo(); release({ ok: false, n: 2 }); assert.equal((await next).n, 2)
  const retry = memo(); assert.equal(loads, 3, 'unavailable results are retried'); release({ ok: true, n: 3 }); await retry
  let fail = true
  const failing = ttlMemo(async () => { if (fail) throw Error('down'); return 'up' }, 1000)
  await assert.rejects(failing(), /down/)
  fail = false; assert.equal(await failing(), 'up')
})

test('listMarkets queries once per window and keeps Date and BigInt-derived values intact', async () => {
  const indexedAt = new Date('2026-01-02T03:04:05Z')
  let queries = 0
  process.env.DATABASE_URL = 'postgres://memo-test.invalid/db'
  globalThis.__gitfunPool = { query: async () => { queries++; return { rows: [{ repoId: '1', mint: 'm', indexedAt, stars: '7', forks: '2', earned: '1234', claimed: '200', volume24hLamports: '5' }] } } }
  const { listMarkets } = await import('../app/lib/server.mjs')
  const [first, second] = await Promise.all([listMarkets(), listMarkets()])
  const third = await listMarkets()
  assert.equal(queries, 1); assert.equal(first, second); assert.equal(first, third)
  const [market] = first.markets
  assert.ok(market.indexedAt instanceof Date); assert.equal(market.indexedAt.getTime(), indexedAt.getTime())
  assert.equal(market.stars, 7); assert.equal(market.remaining, '1034'); assert.equal(market.earned, '1234')
})
