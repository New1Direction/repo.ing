import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { approvedConfigs, createMarketConfigResolver, readPoolConfig } from '../src/market-config.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID } from '../src/early-access-hook.mjs'

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

test('approved configs list the current config first, then distinct legacy configs', () => {
  const current = Keypair.generate().publicKey, legacy = Keypair.generate().publicKey
  assert.deepEqual(approvedConfigs(current, ` ${legacy},${current},${legacy} `).map(key => key.toBase58()), [current.toBase58(), legacy.toBase58()])
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

test('a contributor early access market resolves only on a path that opts in, only to the early access config and hook', () => {
  const current = Keypair.generate().publicKey, earlyAccess = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
  const hook = EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58()
  const on = key => deriveDbcPoolAddress(NATIVE_MINT, mint, key).toBase58()
  const stamped = { mint: mint.toBase58(), pool: on(earlyAccess), earlyAccessEnd: new Date(), transferHookProgram: hook }
  // Every path that does not opt in refuses it, as before.
  assert.throws(() => createMarketConfigResolver(current, '', null)(stamped), /transfer-hook-aware path/)
  assert.throws(() => createMarketConfigResolver(current, '', null)({ ...stamped, earlyAccessEnd: null }), /transfer-hook-aware path/)
  const resolve = createMarketConfigResolver(current, '', null, { earlyAccess })
  assert.ok(resolve(stamped).equals(earlyAccess))
  assert.ok(resolve({ ...stamped, earlyAccessEnd: null }).equals(earlyAccess), 'stamped by its hook program alone')
  // Only the hook program it is meant to have, and only a pool on the early access config.
  assert.throws(() => resolve({ ...stamped, transferHookProgram: Keypair.generate().publicKey.toBase58() }), /early access hook program/)
  assert.throws(() => resolve({ ...stamped, transferHookProgram: null }), /early access hook program/)
  assert.throws(() => resolve({ ...stamped, pool: on(current) }), /early access config/)
  // An unstamped market never resolves to the early access config, even listed among the legacy configs.
  assert.throws(() => createMarketConfigResolver(current, earlyAccess.toBase58(), null, { earlyAccess })({ mint: mint.toBase58(), pool: on(earlyAccess) }), /Only an early access market/)
  // SOL markets resolve as before with the opt-in.
  assert.ok(resolve({ mint: mint.toBase58(), pool: on(current) }).equals(current))
})
