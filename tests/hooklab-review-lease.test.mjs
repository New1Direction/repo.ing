import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_LEASE_SLOTS, reviewLease } from '../src/hooklab-production-bootstrap.mjs'

// The lifetime check (src/hooklab-*-preparation.mjs) allows validUntilSlot at most 150 slots past the finalized snapshot.
// Counted from the finalized slot the lease always fits; counted from confirmed it did not once finality lagged 32 slots.
test('a review lease counts 140 slots from the finalized slot, inside the 150-slot lifetime ceiling at any finality lag', () => {
  const lease = reviewLease(1_000, 5_000)
  assert.deepEqual(lease, { nowMs: 5_000, validUntilSlot: 1_000 + REVIEW_LEASE_SLOTS, reviewExpiresAtMs: 65_000 })
  for (const snapshotAhead of [0, 1, 10]) assert.ok(lease.validUntilSlot - (1_000 + snapshotAhead) <= 150)
  const confirmedBased = (1_000 + 32) + REVIEW_LEASE_SLOTS // the old lease on a 32-slot lag
  assert.ok(confirmedBased - 1_000 > 150, 'the confirmed-based lease broke the ceiling on a local validator')
})
