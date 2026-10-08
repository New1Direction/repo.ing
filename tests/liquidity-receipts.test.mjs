import test from 'node:test'
import assert from 'node:assert/strict'
import { LIQUIDITY_RECEIPTS, REPOING_POOL, liquidityTotals } from '../app/lib/liquidity-receipts.mjs'

test('protocol liquidity totals match the verified deposits and report lock state', () => {
  assert.deepEqual(liquidityTotals(), { solLamports: 1711400001n + 1741250001n + 995000001n + 995000001n, tokenBaseUnits: 3011505954141n + 2222128769339n + 1259651284748n + 613821656139n, allLocked: false })
  assert.equal(liquidityTotals(LIQUIDITY_RECEIPTS.map(receipt => ({ ...receipt, locked: true }))).allLocked, true)
})

test('liquidity receipts must target the canonical pool and never repeat', () => {
  const [receipt] = LIQUIDITY_RECEIPTS
  assert.throws(() => liquidityTotals([{ ...receipt, pool: 'Other111111111111111111111111111111111111111' }]), /Invalid liquidity receipt/)
  assert.throws(() => liquidityTotals([receipt, receipt]), /Duplicate liquidity receipt/)
  assert.equal(receipt.pool, REPOING_POOL)
})
