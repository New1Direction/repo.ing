import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { bundleCurveConfig, isBundleMarket } from '../src/bundles.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'

const config = Keypair.generate().publicKey, legacy = Keypair.generate().publicKey, bundle = Keypair.generate().publicKey
const marketOn = (key, extra = {}) => {
  const mint = Keypair.generate().publicKey
  return { mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, key).toBase58(), ...extra }
}

test('a bundle market is one with a bundle id', () => {
  assert.equal(isBundleMarket({ bundleId: '5' }), true)
  assert.equal(isBundleMarket({ bundleId: 5n }), true)
  for (const market of [{ bundleId: null }, {}, null, undefined]) assert.equal(isBundleMarket(market), false)
})

test('the bundle config comes from BUNDLE_DBC_CONFIG and a malformed one fails loudly', () => {
  assert.equal(bundleCurveConfig({}), null)
  assert.equal(bundleCurveConfig({ BUNDLE_DBC_CONFIG: ' ' }), null)
  assert.ok(bundleCurveConfig({ BUNDLE_DBC_CONFIG: bundle.toBase58() }).equals(bundle))
  assert.throws(() => bundleCurveConfig({ BUNDLE_DBC_CONFIG: 'not-a-key' }))
})

test('the resolver approves the bundle config for bundle markets, and only for them when the stamp is known', () => {
  const resolve = createMarketConfigResolver(config, [legacy], bundle)
  assert.ok(resolve(marketOn(config)).equals(config))
  assert.ok(resolve(marketOn(legacy)).equals(legacy))
  // A bundle market resolves to the bundle config, and only to it.
  assert.ok(resolve(marketOn(bundle, { bundleId: '3' })).equals(bundle))
  assert.throws(() => resolve(marketOn(config, { bundleId: '3' })), /bundle config/)
  // A market read without its stamp (most paths) still resolves on the bundle config; one read with it (bundleId null) does not.
  assert.ok(resolve(marketOn(bundle)).equals(bundle))
  assert.throws(() => resolve(marketOn(bundle, { bundleId: null })), /Only a bundle market/)
  // Without a bundle config, a bundle market fails loudly instead of resolving elsewhere.
  const withoutBundle = createMarketConfigResolver(config, [legacy], null)
  assert.throws(() => withoutBundle(marketOn(bundle, { bundleId: '3' })), /BUNDLE_DBC_CONFIG/)
  assert.throws(() => withoutBundle(marketOn(bundle)), /approved DBC config/)
  // A bundle market is never also a stock pair or an early access market.
  assert.throws(() => resolve(marketOn(bundle, { bundleId: '3', quoteMint: PublicKey.default.toBase58() })), /Stock-paired/)
})

test('migration 0060 is journaled after 0059, re-appliable, and its constraint names match the schema', () => {
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  assert.deepEqual(entries.find(entry => entry.tag === '0060_bundles'), { idx: 60, version: '7', when: 1790910020000, tag: '0060_bundles', breakpoints: true })
  assert.equal(entries.findIndex(entry => entry.tag === '0060_bundles'), entries.findIndex(entry => entry.tag === '0059_early_access') + 1)
  const sql = readFileSync('drizzle/0060_bundles.sql', 'utf8')
  for (const statement of sql.split('--> statement-breakpoint').map(part => part.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
    assert.match(statement, /^(SET LOCAL|ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS|DO \$\$ BEGIN\s+IF NOT EXISTS|CREATE OR REPLACE FUNCTION|CREATE TABLE IF NOT EXISTS|CREATE SEQUENCE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/, statement.slice(0, 80))
  }
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  const names = [...sql.matchAll(/CONSTRAINT "(\w+)"|conname = '(\w+)'|INDEX IF NOT EXISTS "(\w+)"/g)].map(match => match[1] ?? match[2] ?? match[3])
  assert.deepEqual([...new Set(names)].sort(), ['bundles_amounts_check', 'bundles_id_check', 'bundles_one_live_per_repo', 'bundles_status_check', 'markets_bundle_check',
    'markets_bundle_id_unique'])
  for (const name of names) assert.ok(schema.includes(`'${name}'`), `${name} is declared in src/db/schema.mjs`)
})
