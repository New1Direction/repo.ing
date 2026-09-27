import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import { readChainPoint } from '../src/chain-clock.mjs'

const owner = new PublicKey('Sysvar1111111111111111111111111111111111111')
function clock() {
  const data = Buffer.alloc(40)
  data.writeBigUInt64LE(9007199254740993n, 0)
  data.writeBigInt64LE(1790370800n, 32)
  return { owner, data }
}
test('quotes use the on-chain clock even when block time is unavailable', async () => {
  let reads = 0
  const connection = {
    getBlockTime: async () => { throw Error('Block not available') },
    getSlot: async () => { throw Error('Should not need a separate slot request') },
    getAccountInfo: async (address, commitment) => {
      reads++
      assert.ok(address.equals(SYSVAR_CLOCK_PUBKEY))
      assert.equal(commitment, 'confirmed')
      return clock()
    },
  }
  assert.equal((await readChainPoint(connection, 1)).toString(), '1790370800')
  assert.equal(reads, 1)
  assert.equal((await readChainPoint(connection, 0)).toString(), '9007199254740993')
})
test('missing, malformed, wrong-owner, negative, and unknown clock values fail closed', async () => {
  const negative = clock(); negative.data.writeBigInt64LE(-1n, 32)
  for (const account of [null, { ...clock(), data: Buffer.alloc(39) },
    { ...clock(), owner: PublicKey.default }, negative]) {
    await assert.rejects(() => readChainPoint({ getAccountInfo: async () => account }, 1), /clock is unavailable/)
  }
  await assert.rejects(() => readChainPoint({}, 2), /activation type/)
})
