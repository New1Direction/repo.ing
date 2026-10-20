// The public market API serves only coins launched through repo.ing; a database failure reads as unavailable, not unlisted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { COIN_PAGE_CACHE_MS, createMarketHandler, listedCoin } from '../app/lib/hooklab-market.mjs'
import { delistedNotice } from '../src/hooklab-coin-moderation.mjs'

const mintOf = () => Keypair.generate().publicKey.toBase58()
const view = mint => ({ market: { mint, name: 'Coin', symbol: 'COIN' }, wallet: null })
function handlerFor(service) {
  const handler = createMarketHandler({ env: {}, runtime: () => service, allowed: () => true })
  return mint => handler(new Request(`https://repo.ing/api/hook-lab/market/${mint}`), { mint })
}

test('a listed coin returns its market and profile; a Hooks coin launched outside repo.ing is not served', async () => {
  const listed = mintOf(), outside = mintOf(), reads = []
  const read = handlerFor({ market: async mint => { reads.push(mint); return view(mint) }, coinProfile: async mint => mint === listed ? { id: 'r1', name: 'Coin', symbol: 'COIN', creator: listed, profile: null } : null })
  const ok = await read(listed)
  assert.equal(ok.status, 200); assert.equal((await ok.json()).coin.id, 'r1')
  const hidden = await read(outside)
  assert.equal(hidden.status, 404); assert.match((await hidden.json()).error, /isn’t listed on repo\.ing/)
  assert.deepEqual(reads, [listed], 'an unlisted coin is never read from Solana')
})

test('an unreachable database or a runtime without listings is unavailable, never "not listed"', async () => {
  const down = await handlerFor({ market: async mint => view(mint), coinProfile: async () => { throw Error('database down') } })(mintOf())
  assert.equal(down.status, 503)
  assert.equal((await handlerFor({ market: async mint => view(mint) })(mintOf())).status, 503)
  assert.equal((await handlerFor({ market: async mint => view(mint), coinProfile: async () => null })('not-a-mint')).status, 404)
})

// Regression (self-serve acceptance, 2026-10-19): the coin page kept a coin's record (its moderation included) for 60 s, so
// a page opened just before a delisting showed no notice for up to a minute while the trade panel already said delisted.
test('a delisting reaches the coin page\'s coin record within the market data\'s 3 s, not after a minute', async () => {
  const mint = mintOf(), notice = delistedNotice('impersonation')
  let clock = 1_000_000, moderation = { delisted: false }, reads = 0
  const service = { coinProfile: async () => { reads++; return { id: 'r1', name: 'Coin', symbol: 'COIN', stack: 'own', moderation } } }
  const record = () => listedCoin(service, mint, () => clock)
  assert.equal((await record()).moderation.delisted, false)
  moderation = { delisted: true, reason: 'impersonation', notice } // the owner delists the coin
  clock += COIN_PAGE_CACHE_MS - 1
  assert.equal((await record()).moderation.delisted, false, 'inside the shared 3 s cache')
  clock += 1
  const after = await record()
  assert.deepEqual([after.moderation.delisted, after.moderation.notice], [true, notice])
  assert.equal(COIN_PAGE_CACHE_MS, 3000); assert.equal(reads, 2)
})
