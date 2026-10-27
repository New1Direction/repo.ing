import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { programDataCachedConnection, PROGRAM_DATA_HEADER } from '../src/hooklab-program-data-cache.mjs'

// 2026-10-27: every Hooks preparation step re-read ~6 MB of ProgramData from both providers, which put the review → submit
// sequence past its 140-slot lease on a slower container. ProgramData bodies may be reused only while a fresh read of their
// header (kind, deploy slot, upgrade authority), size, lamports, owner and executable flag is unchanged.
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const programData = (slot, size, fill = 7) => {
  const data = Buffer.alloc(size, fill)
  data.writeUInt32LE(3, 0); data.writeBigUInt64LE(BigInt(slot), 4); data[12] = 1; Buffer.alloc(32, 9).copy(data, 13)
  return data
}
const account = (data, lamports, owner = LOADER) => ({ data, lamports, owner, executable: false, rentEpoch: 18446744073709551615, space: data.length })

function chain() {
  const accounts = new Map(), calls = []
  let slot = 100
  const connection = {
    rpcEndpoint: 'https://example.invalid',
    async getMultipleAccountsInfoAndContext(keys, config = {}) {
      slot++
      if (config.minContextSlot !== undefined) assert.ok(slot >= config.minContextSlot)
      const slice = config.dataSlice
      calls.push({ keys: keys.map(k => k.toBase58()), slice: !!slice, bytes: 0 })
      const value = keys.map(k => {
        const a = accounts.get(k.toBase58()); if (!a) return null
        const data = slice ? Buffer.from(a.data.subarray(slice.offset, slice.offset + slice.length)) : Buffer.from(a.data)
        calls.at(-1).bytes += data.length
        return { ...a, data }
      })
      return { context: { slot }, value }
    },
    async getSlot() { return slot },
  }
  return { accounts, calls, connection }
}

const keys = () => {
  const pd = Keypair.generate().publicKey, config = Keypair.generate().publicKey, missing = Keypair.generate().publicKey
  return { pd, config, missing }
}

test('the second read of an unchanged ProgramData account fetches only its header, and returns the same bytes', async () => {
  const { accounts, calls, connection } = chain(), { pd, config, missing } = keys()
  accounts.set(pd.toBase58(), account(programData(50, 600_000), 4_000_000_000))
  accounts.set(config.toBase58(), account(Buffer.from('config-bytes'), 1_000_000, Keypair.generate().publicKey))
  const cached = programDataCachedConnection(connection)
  const request = [config, pd, missing]
  const first = await cached.getMultipleAccountsInfoAndContext(request, { commitment: 'finalized' })
  const second = await cached.getMultipleAccountsInfoAndContext(request, { commitment: 'finalized' })
  const uncached = await connection.getMultipleAccountsInfoAndContext(request, { commitment: 'finalized' })
  for (const result of [first, second]) assert.deepEqual(result.value, uncached.value)
  assert.equal(second.value[2], null)
  // Call 1 full; then the rest in full and only the ProgramData header; then the plain uncached reference read.
  assert.deepEqual(calls.map(c => [c.slice, c.keys.length]), [[false, 3], [false, 2], [true, 1], [false, 3]])
  assert.equal(calls[2].bytes, PROGRAM_DATA_HEADER)
  assert.ok(calls[1].bytes < 100)
  second.value[1].data[100] ^= 1
  const third = await cached.getMultipleAccountsInfoAndContext(request, { commitment: 'finalized' })
  assert.deepEqual(third.value[1].data, uncached.value[1].data, 'callers cannot change the cached bytes')
})

test('an upgrade, an extension, a lamport change or an authority change forces a full re-read', async () => {
  for (const change of [
    a => ({ ...a, data: programData(51, a.data.length, 8) }),            // upgraded: new deploy slot and bytes
    a => ({ ...a, data: programData(50, a.data.length + 10_240), space: a.data.length + 10_240 }), // extended, same slot
    a => ({ ...a, lamports: a.lamports + 1 }),                            // lamports moved
    a => { const data = Buffer.from(a.data); data[12] = 0; return { ...a, data } }, // authority removed (header differs)
    a => ({ ...a, executable: true }),
  ]) {
    const { accounts, calls, connection } = chain(), { pd } = keys()
    accounts.set(pd.toBase58(), account(programData(50, 4_096), 99_000))
    const cached = programDataCachedConnection(connection)
    await cached.getMultipleAccountsInfoAndContext([pd], { commitment: 'finalized' })
    accounts.set(pd.toBase58(), change(accounts.get(pd.toBase58())))
    const after = await cached.getMultipleAccountsInfoAndContext([pd], { commitment: 'finalized' })
    const truth = await connection.getMultipleAccountsInfoAndContext([pd], { commitment: 'finalized' })
    assert.deepEqual(after.value, truth.value)
    assert.deepEqual(calls.map(c => c.slice), [false, true, false, false], 'header read, then a full read, then the reference')
    // The refreshed bytes are what the next header check compares against.
    const again = await cached.getMultipleAccountsInfoAndContext([pd], { commitment: 'finalized' })
    assert.deepEqual(again.value, truth.value)
    assert.equal(calls.at(-1).slice, true)
  }
})

test('a closed ProgramData account, a caller dataSlice and non-ProgramData accounts are never served from the cache', async () => {
  const { accounts, calls, connection } = chain(), { pd, config } = keys()
  accounts.set(pd.toBase58(), account(programData(50, 2_048), 99_000))
  accounts.set(config.toBase58(), account(Buffer.alloc(300, 1), 5_000, Keypair.generate().publicKey))
  const cached = programDataCachedConnection(connection)
  await cached.getMultipleAccountsInfoAndContext([pd, config], { commitment: 'finalized' })
  const sliced = await cached.getMultipleAccountsInfoAndContext([pd], { commitment: 'finalized', dataSlice: { offset: 0, length: 8 } })
  assert.equal(sliced.value[0].data.length, 8)
  accounts.delete(pd.toBase58())
  const closed = await cached.getMultipleAccountsInfoAndContext([pd, config], { commitment: 'finalized' })
  assert.equal(closed.value[0], null)
  assert.equal(closed.value[1].data.length, 300)
  assert.deepEqual(calls.map(c => [c.slice, c.keys.length]), [[false, 2], [true, 1], [false, 1], [true, 1], [false, 2]])
})

test('the context slot is the full read\'s, and the header is read at or after it', async () => {
  const { accounts, connection } = chain(), { pd, config } = keys()
  accounts.set(pd.toBase58(), account(programData(50, 2_048), 99_000))
  accounts.set(config.toBase58(), account(Buffer.alloc(10), 5_000, Keypair.generate().publicKey))
  const seen = []
  const spy = { ...connection, async getMultipleAccountsInfoAndContext(k, c) { seen.push(c.minContextSlot); return connection.getMultipleAccountsInfoAndContext(k, c) } }
  const cached = programDataCachedConnection(spy)
  await cached.getMultipleAccountsInfoAndContext([pd, config], { commitment: 'finalized', minContextSlot: 90 })
  const second = await cached.getMultipleAccountsInfoAndContext([pd, config], { commitment: 'finalized', minContextSlot: 90 })
  assert.deepEqual(seen.slice(1), [90, second.context.slot])
})
