import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { marketTokenMetrics } from '../app/lib/market-metrics.mjs'
import { solUsdPrice } from '../app/lib/sol-usd.mjs'

test('concurrent market viewers share one holder/supply request, and failed requests can retry', async () => {
  const mint = Keypair.generate().publicKey.toBase58(), pool = Keypair.generate().publicKey.toBase58()
  let supplies = 0, holders = 0, fail = true
  const connection = {
    async getTokenSupply() { supplies++; await new Promise(r => setTimeout(r, 10)); if (fail) throw Error('RPC unavailable'); return { value: { amount: '1000000000000000', decimals: 6 } } },
    async getProgramAccounts() { holders++; return [] },
  }
  const failed = await Promise.allSettled([marketTokenMetrics(connection, mint, pool), marketTokenMetrics(connection, mint, pool)])
  assert.ok(failed.every(r => r.status === 'rejected'))
  assert.equal(supplies, 1); assert.equal(holders, 1)
  fail = false
  const [a, b] = await Promise.all([marketTokenMetrics(connection, mint, pool), marketTokenMetrics(connection, mint, pool)])
  assert.deepEqual(a, b); assert.equal(a.holders, 0); assert.equal(supplies, 2)
  await marketTokenMetrics(connection, mint, pool)
  assert.equal(supplies, 2)
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
