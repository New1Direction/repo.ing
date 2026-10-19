// SOL/USD for USD-priced launches: every source read at invite time, and a cached estimate for the creator page.
// Scripted fetch only; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { launchPriceAtInvite, launchPriceEstimate } from '../app/lib/hooklab-launch-price.mjs'
import { SOL_USD_SOURCES, readSolUsdSources } from '../src/sol-usd-sources.mjs'

const bodies = { coingecko: usd => ({ solana: { usd } }), jupiter: usd => ({ So11111111111111111111111111111111111111112: { usdPrice: usd } }), coinbase: usd => ({ data: { amount: String(usd) } }) }
// prices: { coingecko: 105.62, ... }; a missing source answers 503.
function sources(prices, calls = []) {
  return async url => {
    const [name] = SOL_USD_SOURCES.find(([, address]) => address === url); calls.push(name)
    return prices[name] === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => bodies[name](prices[name]) }
  }
}

test('the same three sources as the site price, all read at once, failures left out', async () => {
  assert.deepEqual(SOL_USD_SOURCES.map(([name]) => name), ['coingecko', 'jupiter', 'coinbase'])
  const calls = []
  assert.deepEqual(await readSolUsdSources(sources({ coingecko: 105.62, coinbase: 105.64 }, calls)), [{ source: 'coingecko', usd: 105.62 }, { source: 'coinbase', usd: 105.64 }])
  assert.deepEqual(calls.sort(), ['coinbase', 'coingecko', 'jupiter'])
  assert.deepEqual(await readSolUsdSources(async () => { throw Error('offline') }), [])
})

test('the invite price is the agreeing median with its virtual quote, or a clear refusal', async () => {
  assert.deepEqual(await launchPriceAtInvite(sources({ coingecko: 105.62, jupiter: 105.63, coinbase: 105.64 })), {
    solUsdMicros: '105630000', virtualQuote: '53251917070',
    sources: [{ source: 'coingecko', usdMicros: '105620000' }, { source: 'jupiter', usdMicros: '105630000' }, { source: 'coinbase', usdMicros: '105640000' }] })
  assert.equal((await launchPriceAtInvite(sources({ jupiter: 150, coinbase: 150 }))).virtualQuote, '37500000000', 'CoinGecko rate-limited: two sources still agree')
  await assert.rejects(launchPriceAtInvite(sources({ coingecko: 150 })), err => err.code === 'LAUNCH_PRICE_REFUSED' && /Only 1 SOL price source answered/.test(err.message))
  const outlier = await launchPriceAtInvite(sources({ coingecko: 150, jupiter: 160, coinbase: 150 }))
  assert.equal(outlier.virtualQuote, '37500000000', 'one stale source is ignored when the other two agree')
  assert.deepEqual(outlier.sources[1], { source: 'jupiter', usdMicros: '160000000', ignored: true })
  await assert.rejects(launchPriceAtInvite(sources({ coingecko: 150, coinbase: 160 })), /fewer than two are within 2% of their median/)
  await assert.rejects(launchPriceAtInvite(sources({ coingecko: 40, jupiter: 40 })), /outside the launch config's 5\.625–112\.5 SOL bounds/)
})

test('the creator estimate is cached for a minute and is null (not stale) while sources fail', async () => {
  const calls = []
  assert.deepEqual(await launchPriceEstimate(sources({ coingecko: 105.62, jupiter: 105.63, coinbase: 105.64 }, calls), 1_000), { solUsdMicros: '105630000', virtualQuote: '53251917070' })
  assert.deepEqual(await launchPriceEstimate(sources({ coingecko: 999 }, calls), 50_000), { solUsdMicros: '105630000', virtualQuote: '53251917070' })
  assert.equal(calls.length, 3, 'one read per minute however often the page polls')
  assert.equal(await launchPriceEstimate(sources({ coingecko: 999 }, calls), 61_001), null, 'expired and one source left: no estimate')
  assert.equal(await launchPriceEstimate(sources({ coingecko: 150, jupiter: 150 }, calls), 80_000), null, 'failures back off for 30 seconds')
  assert.deepEqual(await launchPriceEstimate(sources({ coingecko: 150, jupiter: 150 }, calls), 91_001), { solUsdMicros: '150000000', virtualQuote: '37500000000' })
})
