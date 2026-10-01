import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver, readPoolConfig } from '../src/market-config.mjs'

test('config rotation preserves legacy markets and rejects unapproved pools', () => {
  const current = Keypair.generate().publicKey, legacy = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  const mint = Keypair.generate().publicKey
  const market = key => ({ mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, key).toBase58() })
  const resolve = createMarketConfigResolver(current, ` ${legacy},${current},${legacy} `)
  assert.ok(resolve(market(current)).equals(current))
  assert.ok(resolve(market(legacy)).equals(legacy))
  assert.throws(() => resolve(market(other)), /approved DBC config/)
  assert.throws(() => createMarketConfigResolver(current, '')(market(legacy)), /approved DBC config/)
  assert.throws(() => resolve({ ...market(legacy), mint: other.toBase58() }), /approved DBC config/)
  assert.throws(() => createMarketConfigResolver(current, 'invalid'))
})

test('DBC config reads are shared per endpoint and commitment; misses and failures are not kept', async () => {
  const config = Keypair.generate().publicKey
  let calls = 0, answer = null, fail = false
  const client = (endpoint, commitment = 'finalized') => ({ connection: { rpcEndpoint: endpoint }, commitment,
    state: { getPoolConfig: async key => { calls++; assert.ok(key.equals(config)); if (fail) throw Error('rpc down'); return answer } } })
  const dbc = client('https://one.example')
  assert.equal(await readPoolConfig(dbc, config), null)
  answer = { migrationQuoteThreshold: 85 }
  const [a, b] = await Promise.all([readPoolConfig(dbc, config), readPoolConfig(client('https://one.example'), config)])
  assert.equal(a, answer); assert.equal(b, answer)
  assert.equal(calls, 2, 'the miss was not cached; concurrent reads shared one request')
  await readPoolConfig(dbc, config)
  assert.equal(calls, 2)
  await readPoolConfig(client('https://one.example', 'confirmed'), config)
  await readPoolConfig(client('https://two.example'), config)
  assert.equal(calls, 4, 'per commitment and endpoint')
  fail = true
  const other = Keypair.generate().publicKey
  await assert.rejects(readPoolConfig({ ...client('https://three.example'), state: { getPoolConfig: async () => { throw Error('rpc down') } } }, other), /rpc down/)
  let clock = 0
  await readPoolConfig(client('https://four.example'), config, { now: () => clock }).catch(() => null)
  fail = false
  assert.equal(await readPoolConfig(client('https://four.example'), config, { now: () => clock }), answer, 'a failure is retried')
  clock += 3_600_000
  const before = calls
  await readPoolConfig(client('https://four.example'), config, { now: () => clock })
  assert.equal(calls, before + 1, 'hourly backstop refresh')
})
