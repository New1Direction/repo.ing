import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { formatSolMarketCap, formatUsdMarketCap } from '../app/lib/market-display.mjs'
import { uniqueHolderCount } from '../app/lib/market-metrics.mjs'

const account = (address, owner, balance) => {
  const data = Buffer.alloc(40)
  new PublicKey(owner).toBuffer().copy(data)
  data.writeBigUInt64LE(BigInt(balance), 32)
  return { pubkey: new PublicKey(address), account: { data } }
}

test('market cap uses compact USD labels', () => {
  assert.equal(formatUsdMarketCap(999), '$999')
  assert.equal(formatUsdMarketCap(1000), '$1k')
  assert.equal(formatUsdMarketCap(3300), '$3.3k')
  assert.equal(formatUsdMarketCap(1250000), '$1.3m')
  assert.equal(formatUsdMarketCap(NaN), '—')
})

test('compact labels choose the suffix after rounding: $1m, never $1000k', () => {
  assert.deepEqual([999.4, 999.6, 999_949, 999_960, 994_999, 999_960_000, 999_960_000_000].map(formatUsdMarketCap),
    ['$999', '$1k', '$999.9k', '$1m', '$995k', '$1b', '$1t'])
  assert.deepEqual([999.94, 999.96, 999_960, 999_960_000].map(formatSolMarketCap), ['999.9 SOL', '1k SOL', '1m SOL', '1b SOL'])
  for (let value = 1; value < 1e13; value *= 1.0007) assert.doesNotMatch(formatUsdMarketCap(value), /1000[ktmb]$/)
})

test('holder count excludes the pool vault, zero balances, and duplicate owner accounts', () => {
  const [vault, ata1, ata2, empty, owner, other] = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58())
  assert.equal(uniqueHolderCount([
    account(vault, other, 999),
    account(ata1, owner, 5),
    account(ata2, owner, 2),
    account(empty, other, 0),
  ], vault), 1)
})
