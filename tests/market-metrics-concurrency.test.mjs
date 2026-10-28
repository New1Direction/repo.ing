import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { marketTokenMetrics } from '../app/lib/market-metrics.mjs'
import { solUsdPrice } from '../app/lib/sol-usd.mjs'

test('concurrent market viewers share one holder request, supply is the mint_facts row, and failed requests can retry', async () => {
  // Arrange
  const mint = Keypair.generate().publicKey.toBase58(), pool = Keypair.generate().publicKey.toBase58()
  let holders = 0, fail = true
  const supplyReads = []
  const db = { query: async (sql, params) => { supplyReads.push(params); return { rows: /from mint_facts/.test(sql) ? [{ supply: '999850848836751', decimals: 6 }] : [] } } }
  const connection = {
    async getTokenSupply() { throw Error('supply must come from mint_facts, never a live read') },
    async getProgramAccounts() { holders++; await new Promise(r => setTimeout(r, 10)); if (fail) throw Error('RPC unavailable'); return [] },
  }
  // Act
  const failed = await Promise.allSettled([marketTokenMetrics(connection, mint, pool, Date.now(), { db }), marketTokenMetrics(connection, mint, pool, Date.now(), { db })])
  fail = false
  const [a, b] = await Promise.all([marketTokenMetrics(connection, mint, pool, Date.now(), { db }), marketTokenMetrics(connection, mint, pool, Date.now(), { db })])
  await marketTokenMetrics(connection, mint, pool, Date.now(), { db })
  // Assert
  assert.ok(failed.every(r => r.status === 'rejected'))
  assert.deepEqual(a, { supplyBaseUnits: '999850848836751', supplyDecimals: 6, holders: 0 })
  assert.deepEqual(a, b)
  assert.equal(holders, 2, 'one shared holder scan per failure and per success, then cached')
  assert.deepEqual(supplyReads.at(-1), [mint])
  await assert.rejects(marketTokenMetrics(connection, Keypair.generate().publicKey.toBase58(), pool), /database/)
  const unread = { query: async () => ({ rows: [] }) }
  assert.deepEqual(await marketTokenMetrics(connection, mint, pool, Date.now(), { db: unread }), { supplyBaseUnits: null, supplyDecimals: null, holders: 0 },
    'a mint not read yet has no supply')
})

test('concurrent FX reads share one request and never return an expired price after failure', async () => {
  let reads = 0
  const fetcher = async () => { reads++; await new Promise(r => setTimeout(r, 5)); return { ok: true, json: async () => ({ solana: { usd: 120 } }) } }
  assert.deepEqual(await Promise.all([solUsdPrice(fetcher, 100), solUsdPrice(fetcher, 100)]), [120, 120])
  assert.equal(reads, 1)
  assert.equal(await solUsdPrice(async () => ({ ok: false }), 400000), null)
})

test('FX falls back to independent USD sources when CoinGecko is rate limited', async () => {
  const seen = []
  const fetcher = async url => { seen.push(new URL(url).host)
    if (url.includes('coingecko')) return { ok: false, status: 429 }
    if (url.includes('jup.ag')) return { ok: true, json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: 119.19 } }) }
    throw Error('unexpected') }
  assert.equal(await solUsdPrice(fetcher, 10_000_000), 119.19)
  assert.deepEqual(seen, ['api.coingecko.com', 'lite-api.jup.ag'])
  const coinbase = async url => url.includes('coinbase') ? { ok: true, json: async () => ({ data: { amount: '118.5' } }) } : { ok: false }
  assert.equal(await solUsdPrice(coinbase, 20_000_000), 118.5)
  let calls = 0
  const down = async () => { calls++; return { ok: false } }
  assert.equal(await solUsdPrice(down, 30_000_000), null)
  assert.equal(await solUsdPrice(down, 30_010_000), null)
  assert.equal(calls, 3)
})
