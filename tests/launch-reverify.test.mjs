import test from 'node:test'
import assert from 'node:assert/strict'
import { launchesToVerify } from '../src/launch-indexer.mjs'

test('settling launches are verified every run; indexed finalized launches only when stale, oldest first, bounded', () => {
  const now = Date.parse('2026-09-30T12:00:00Z'), hour = 3_600_000
  const market = (id, fields) => ({ githubRepoId: BigInt(id), status: 'confirmed', indexedAt: new Date(now - 10 * hour),
    launchFinality: 'finalized', lastVerifiedAt: new Date(now - 10 * 60_000), ...fields })
  const candidates = [
    market(1), market(2, { status: 'submitted', indexedAt: null, launchFinality: null, lastVerifiedAt: null }),
    market(3, { lastVerifiedAt: new Date(now - 2 * hour) }), market(4, { lastVerifiedAt: new Date(now - 3 * hour) }),
    market(5, { indexedAt: null, lastVerifiedAt: null, launchFinality: null }), market(6, { lastVerifiedAt: new Date(now - 5 * hour) }),
  ]
  const ids = list => list.map(item => Number(item.githubRepoId))
  assert.deepEqual(ids(launchesToVerify(candidates, { now, reverifyAfterMs: hour, maxReverify: 2 })), [2, 5, 6, 4])
  assert.deepEqual(ids(launchesToVerify(candidates, { now, reverifyAfterMs: hour, maxReverify: 5, retryAt: new Map([['6', now + 1]]) })), [2, 5, 4, 3])
  assert.deepEqual(ids(launchesToVerify(candidates, { now, reverifyAfterMs: 6 * hour })), [2, 5])
})
