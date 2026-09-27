import test from 'node:test'
import assert from 'node:assert/strict'
import { discoveryEarned, eligibleDiscoveryFee, DISCOVERY_WINDOW_MS } from '../src/discovery-rewards.mjs'

test('reward is half actual partner fees, rounds once, and caps total earnings at 1 SOL', () => {
  assert.equal(discoveryEarned(1n), 0n)
  assert.equal(discoveryEarned(3n), 1n)
  assert.equal(discoveryEarned(1n + 3n), 2n)
  assert.equal(discoveryEarned(3n + 1n), 2n)
  assert.equal(discoveryEarned(1_999_999_999n), 999_999_999n)
  assert.equal(discoveryEarned(20_000_000_000n), 1_000_000_000n)
  assert.throws(() => discoveryEarned(-1n), /Negative/)
})

test('only enrolled launches earn; chain timestamps define the inclusive start and exclusive 30-day end', () => {
  const start = new Date('2026-09-25T00:00:00Z')
  const market = { discoveryVersion: 1, launchBlockTime: start }
  const event = date => ({ currentTimestamp: BigInt(date.getTime() / 1000) })
  assert.equal(eligibleDiscoveryFee(market, event(start)), true)
  assert.equal(eligibleDiscoveryFee(market, event(new Date(start.getTime() - 1000))), false)
  assert.equal(eligibleDiscoveryFee(market, event(new Date(start.getTime() + DISCOVERY_WINDOW_MS - 1000))), true)
  assert.equal(eligibleDiscoveryFee(market, event(new Date(start.getTime() + DISCOVERY_WINDOW_MS))), false)
  assert.equal(eligibleDiscoveryFee({ ...market, discoveryVersion: null }, event(start)), false)
  assert.throws(() => eligibleDiscoveryFee({ ...market, launchBlockTime: null }, event(start)), /timestamp/)
})

test('v2 cap is 2.5 SOL and cannot alter v1 obligations', () => {
  assert.equal(discoveryEarned(8_000_000_000n, 1), 1_000_000_000n)
  assert.equal(discoveryEarned(8_000_000_000n, 2), 2_500_000_000n)
  assert.equal(discoveryEarned(4_999_999_999n, 2), 2_499_999_999n)
  assert.throws(() => discoveryEarned(1n, 3), /Unknown/)
  const start=new Date('2026-09-25T00:00:00Z')
  assert.equal(eligibleDiscoveryFee({discoveryVersion:2,launchBlockTime:start},{currentTimestamp:BigInt(start.getTime()/1000)}),true)
  assert.throws(()=>eligibleDiscoveryFee({discoveryVersion:3,launchBlockTime:start},{currentTimestamp:BigInt(start.getTime()/1000)}),/Unknown/)
})
