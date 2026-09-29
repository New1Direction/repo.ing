import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { allocationReserveValid, FIXED_SUPPLY } from '../src/builder-allocation.mjs'

const creator = Keypair.generate().publicKey, configKey = Keypair.generate().publicKey, baseMint = Keypair.generate().publicKey
const market = { creatorWallet: creator.toBase58(), mint: baseMint.toBase58() }
const fixed = { leftoverReceiver: creator, quoteMint: NATIVE_MINT, tokenType: 0, preMigrationTokenSupply: { toString: () => String(FIXED_SUPPLY) } }
const state = { poolState: { creator, config: configKey, baseMint } }
const mint = { supply: FIXED_SUPPLY, decimals: 6, mintAuthority: null, freezeAuthority: null }
const valid = overrides => allocationReserveValid({ market, configKey, state, fixed, mint, ...overrides })

test('a fixed-supply market passes the reserve check', () => {
  assert.equal(valid({}), true)
})

test('holders burning tokens does not block the builder allocation ($REPOING: 999,951,689.536089 supply)', () => {
  assert.equal(valid({ mint: { ...mint, supply: 999_951_689_536_089n } }), true)
})

test('inflated supply, a live mint authority, or a non-1B launch config still fail', () => {
  assert.equal(valid({ mint: { ...mint, supply: FIXED_SUPPLY + 1n } }), false)
  assert.equal(valid({ mint: { ...mint, mintAuthority: creator } }), false)
  assert.equal(valid({ mint: { ...mint, freezeAuthority: creator } }), false)
  assert.equal(valid({ fixed: { ...fixed, preMigrationTokenSupply: { toString: () => '999000000000000' } } }), false)
})

test('reserve ownership and pool identity checks are unchanged', () => {
  const other = Keypair.generate().publicKey
  assert.equal(valid({ fixed: { ...fixed, leftoverReceiver: other } }), false)
  assert.equal(valid({ state: { poolState: { ...state.poolState, creator: other } } }), false)
  assert.equal(valid({ state: { poolState: { ...state.poolState, config: other } } }), false)
  assert.equal(valid({ state: { poolState: { ...state.poolState, baseMint: other } } }), false)
  assert.equal(valid({ fixed: { ...fixed, quoteMint: other } }), false)
  assert.equal(valid({ mint: { ...mint, decimals: 9 } }), false)
  assert.equal(valid({ state: null }), false)
})
