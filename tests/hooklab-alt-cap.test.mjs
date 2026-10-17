import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { planCustomPreparation } from '../src/hooklab-custom-preparation.mjs'
import { customPreparationFixture } from './fixtures/hooklab-custom-preparation.mjs'

test('shared message boundary rejects an impossible 257-address ALT even when all used indexes fit', () => {
  const f = customPreparationFixture(), plan = planCustomPreparation(f)
  const addresses = plan.review.accounts.filter(a => !a.signer).map(a => new PublicKey(a.address))
  const used = addresses.length
  while (addresses.length < 257) {
    const b = Buffer.alloc(32, 211); b.writeUInt32LE(addresses.length)
    addresses.push(new PublicKey(b))
  }
  assert.ok(used < 256)
  const bytes = Buffer.alloc(56 + addresses.length * 32)
  bytes.writeUInt32LE(1); bytes.writeBigUInt64LE(0xffffffffffffffffn, 4); bytes.writeBigUInt64LE(10n, 12)
  addresses.forEach((a, i) => a.toBuffer().copy(bytes, 56 + i * 32))
  f.lookupTable = { address: new PublicKey(Buffer.alloc(32, 137)).toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111',
    dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.throws(() => planCustomPreparation(f), /Invalid canonical bytes|256-address/)
})
