// The public market API serves only coins launched through repo.ing; a database failure reads as unavailable, not unlisted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createMarketHandler } from '../app/lib/hooklab-market.mjs'

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
