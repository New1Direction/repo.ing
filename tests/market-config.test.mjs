import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from '../src/market-config.mjs'

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
