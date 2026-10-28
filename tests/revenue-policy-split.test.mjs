// The platform revenue policy split used by DBC/DAMM allocation (src/platform-revenue.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitByPolicy } from '../src/revenue-policy-split.mjs'

test('the policy split is the allocation formula it replaced, and its parts always add up', () => {
  const old = (amount, b, l) => { const buyback = amount * BigInt(b) / 1000n, liquidity = amount * BigInt(l) / 1000n; return { buyback, liquidity, treasury: amount - buyback - liquidity } }
  for (const amount of [0n, 1n, 7n, 999n, 1000n, 1_234_567n, 980_295_001n, 18_446_744_073_709_551_615n]) {
    for (const [b, l] of [[600, 200], [0, 0], [1000, 0], [333, 333]]) {
      const split = splitByPolicy(amount, { buybackPermille: b, liquidityPermille: l })
      assert.deepEqual(split, old(amount, b, l))
      assert.equal(split.buyback + split.liquidity + split.treasury, amount)
    }
  }
  assert.throws(() => splitByPolicy(1n, { buybackPermille: 700, liquidityPermille: 400 }), /summing to at most 1000/)
  assert.throws(() => splitByPolicy(-1n, { buybackPermille: 600, liquidityPermille: 200 }), /negative/)
})
