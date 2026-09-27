import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForLaunchEvidence } from '../src/launch-coordinator.mjs'

test('launch evidence wait handles temporary RPC absence and availability', async () => {
  let calls = 0
  const market = { id: 1 }
  const result = await waitForLaunchEvidence(async seen => {
    assert.equal(seen, market)
    calls++
    if (calls === 1) throw new Error('RPC lag')
    return calls === 3
  }, market, 3, 0)
  assert.equal(result, true)
  assert.equal(calls, 3)
})

test('launch evidence wait ends without treating absence as proof of failure', async () => {
  let calls = 0
  const result = await waitForLaunchEvidence(async () => { calls++; return false }, {}, 2, 0)
  assert.equal(result, false)
  assert.equal(calls, 2)
})
