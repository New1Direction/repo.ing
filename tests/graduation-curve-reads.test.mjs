import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createCurveReads } from '../src/graduation-state.mjs'

const config = Keypair.generate().publicKey
const market = () => { const mint = Keypair.generate().publicKey; return { mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58() } }

function provider(name, slot) {
  const calls = { accounts: [], times: 0 }
  return { calls, rpcEndpoint: `https://${name}.invalid`,
    getMultipleAccountsInfoAndContext: async (keys, commitment) => {
      assert.equal(commitment, 'finalized')
      calls.accounts.push(keys.map(key => key.toBase58()))
      return { context: { slot }, value: keys.map(key => ({ owner: config, data: Buffer.from(`${name}:${key.toBase58()}`) })) }
    },
    getBlockTime: async at => { calls.times++; assert.equal(at, slot); return calls.noTime ? null : 1_700_000_000 } }
}

test('one graduation pass reads every curve pool and config in one call per provider, per batch window', async () => {
  let clock = 0
  const markets = Array.from({ length: 5 }, market), primary = provider('primary', 10), verification = provider('verification', 11)
  const reads = createCurveReads({ connection: primary, verification, config, markets, now: () => clock })
  const first = await reads.read(markets[0])
  assert.deepEqual(primary.calls.accounts, [[...markets.map(m => m.pool).slice(0, 1), config.toBase58(), ...markets.slice(1).map(m => m.pool)]])
  assert.equal(verification.calls.accounts.length, 1)
  assert.deepEqual(first.map(r => r.snapshot.value.map(info => info.data.toString())), [
    [`primary:${markets[0].pool}`, `primary:${config.toBase58()}`], [`verification:${markets[0].pool}`, `verification:${config.toBase58()}`]])
  assert.deepEqual(first.map(r => [r.snapshot.context.slot, r.time]), [[10, 1_700_000_000], [11, 1_700_000_000]])
  clock += 14_000
  const later = await reads.read(markets[3])
  assert.equal(later[1].snapshot.value[0].data.toString(), `verification:${markets[3].pool}`)
  assert.equal(primary.calls.accounts.length, 1, 'still inside the 15 s window')
  clock += 1_000
  await reads.read(markets[4])
  assert.deepEqual(primary.calls.accounts.at(-1), [markets[4].pool, config.toBase58()], 'expired: reload from this market on')
  assert.deepEqual([primary.calls.times, verification.calls.times], [2, 2])
})

test('batches stop at the account limit, skip unapproved markets and still serve every approved one', async () => {
  const markets = Array.from({ length: 4 }, market), stranger = { mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58() }
  const primary = provider('primary', 5), verification = provider('verification', 5)
  const reads = createCurveReads({ connection: primary, verification, config, markets: [markets[0], stranger, ...markets.slice(1)], maxAccounts: 3 })
  await reads.read(markets[0])
  assert.deepEqual(primary.calls.accounts[0], [markets[0].pool, config.toBase58(), markets[1].pool])
  await assert.rejects(reads.read(stranger), /approved DBC config/)
  await reads.read(markets[1])
  assert.equal(primary.calls.accounts.length, 1)
  const third = await reads.read(markets[2])
  assert.equal(third[0].snapshot.value[0].data.toString(), `primary:${markets[2].pool}`)
  assert.deepEqual(primary.calls.accounts[1], [markets[2].pool, config.toBase58(), markets[3].pool])
})

test('a batch whose block time is unavailable fails closed and is not reused', async () => {
  const markets = Array.from({ length: 2 }, market), primary = provider('primary', 7), verification = provider('verification', 7)
  const reads = createCurveReads({ connection: primary, verification, config, markets })
  verification.calls.noTime = true
  await assert.rejects(reads.read(markets[0]), /STALE_PROGRESS/)
  verification.calls.noTime = false
  await reads.read(markets[1])
  assert.equal(primary.calls.accounts.length, 2, 'the next market reads a fresh batch')
})
