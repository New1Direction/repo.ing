import test from 'node:test'
import assert from 'node:assert/strict'
import { publicGraduation, TRANSIENT_REVIEW_CODES } from '../src/graduation-readiness.mjs'
import { PUBLIC_GRADUATION_MAX_AGE_MS } from '../src/graduation-state.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'

const now = Date.parse('2026-10-05T05:00:00.000Z')
const review = (code, options = {}) => ({ ...graduationColumns({ now, rowStatus: 'REVIEW', ...options }), error_code: code })

const lenient = { transientReview: true }

test('the curve endpoint keeps the previous verified observation through a failed read while it is still fresh', () => {
  const verified = publicGraduation(graduationColumns({ now, graduated: true }), now)
  for (const code of TRANSIENT_REVIEW_CODES) {
    assert.deepEqual(publicGraduation(review(code, { graduated: true }), now, lenient), verified, code)
  }
  // A curve market too: its progress stays on screen.
  assert.equal(publicGraduation(review('RPC_UNAVAILABLE', { reserveSol: 40n }), now, lenient).progressPercent,
    publicGraduation(graduationColumns({ now, reserveSol: 40n }), now).progressPercent)
})

test('every other reader still requires a verified latest pass', () => {
  for (const code of TRANSIENT_REVIEW_CODES) assert.throws(() => publicGraduation(review(code, { graduated: true }), now), new RegExp(code))
})

test('the previous observation is served only within its own freshness window, never past it', () => {
  const oldest = PUBLIC_GRADUATION_MAX_AGE_MS - 1000
  assert.ok(publicGraduation(review('EVIDENCE_UNAVAILABLE', { graduated: true, age: oldest }), now, lenient))
  assert.throws(() => publicGraduation(review('EVIDENCE_UNAVAILABLE', { graduated: true, age: PUBLIC_GRADUATION_MAX_AGE_MS + 1000 }), now, lenient), /STALE_PROGRESS/)
})

test('a review for anything the check found withdraws the observation at once, as before', () => {
  for (const code of ['MIGRATION_EVIDENCE_INCOMPLETE', 'GRADUATION_STATE_DISAGREEMENT', 'DUPLICATE_GRADUATION_CONFLICT', 'LP_SETTLEMENT_MISMATCH',
    'DAMM_HISTORY_INCOMPLETE', 'VERIFICATION_RPC_REQUIRED', null]) {
    assert.throws(() => publicGraduation(review(code, { graduated: true }), now, lenient), new RegExp(code ?? 'PROGRESS_NOT_INDEXED'))
  }
  // No verified observation yet: nothing to keep.
  assert.throws(() => publicGraduation({ ...review('RPC_UNAVAILABLE'), observation: null }, now, lenient), /RPC_UNAVAILABLE/)
  // The durable migration proof is still required for a graduated market.
  assert.throws(() => publicGraduation(review('RPC_UNAVAILABLE', { graduated: true, proven: false }), now, lenient), /MIGRATION_EVIDENCE_INCOMPLETE/)
  assert.throws(() => publicGraduation(null, now, lenient), /PROGRESS_NOT_INDEXED/)
})
