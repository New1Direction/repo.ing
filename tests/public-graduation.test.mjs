import test from 'node:test'
import assert from 'node:assert/strict'
import { graduationError, publicGraduation, recordGraduationReview, TRANSIENT_REVIEW_CODES } from '../src/graduation-readiness.mjs'
import { PUBLIC_GRADUATION_MAX_AGE_MS } from '../src/graduation-state.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'
import { REPOING_POOL, liquidityTotals } from '../app/lib/liquidity-receipts.mjs'

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
  assert.ok(publicGraduation(review('RPC_UNAVAILABLE', { graduated: true, age: oldest }), now, lenient))
  assert.throws(() => publicGraduation(review('RPC_UNAVAILABLE', { graduated: true, age: PUBLIC_GRADUATION_MAX_AGE_MS + 1000 }), now, lenient), /STALE_PROGRESS/)
})

test('a review for anything the check found withdraws the observation at once, as before', () => {
  for (const code of ['MIGRATION_EVIDENCE_INCOMPLETE', 'GRADUATION_STATE_DISAGREEMENT', 'DUPLICATE_GRADUATION_CONFLICT', 'LP_SETTLEMENT_MISMATCH',
    'DAMM_HISTORY_INCOMPLETE', 'VERIFICATION_RPC_REQUIRED', 'EVIDENCE_UNAVAILABLE', null]) {
    assert.throws(() => publicGraduation(review(code, { graduated: true }), now, lenient), new RegExp(code ?? 'PROGRESS_NOT_INDEXED'))
  }
  // No verified observation yet: nothing to keep.
  assert.throws(() => publicGraduation({ ...review('RPC_UNAVAILABLE'), observation: null }, now, lenient), /RPC_UNAVAILABLE/)
  // The durable migration proof is still required for a graduated market.
  assert.throws(() => publicGraduation(review('RPC_UNAVAILABLE', { graduated: true, proven: false }), now, lenient), /MIGRATION_EVIDENCE_INCOMPLETE/)
  assert.throws(() => publicGraduation(null, now, lenient), /PROGRESS_NOT_INDEXED/)
})

test('only transport failures become transient codes; any other unrecognized error stays EVIDENCE_UNAVAILABLE', () => {
  const error = (message, extra = {}) => Object.assign(Error(message), extra)
  assert.equal(graduationError(error('fetch failed')), 'RPC_UNAVAILABLE')
  assert.equal(graduationError(error('failed to get info about account X: Error: 503 Service Unavailable: busy')), 'RPC_UNAVAILABLE')
  assert.equal(graduationError(error('failed to get slot: RPC_UNAVAILABLE')), 'RPC_UNAVAILABLE')
  assert.equal(graduationError(error('aborted', { name: 'TimeoutError' })), 'RPC_UNAVAILABLE')
  assert.equal(graduationError(error('failed to get balance: Error: 429 Too Many Requests: slow down')), 'RPC_RATE_LIMITED')
  assert.equal(graduationError(error('RPC_RATE_LIMITED')), 'RPC_RATE_LIMITED')
  assert.equal(graduationError(error('Graduated partner position is unavailable')), 'EVIDENCE_UNAVAILABLE')
  assert.equal(graduationError(error('MIGRATION_EVIDENCE_INCOMPLETE')), 'MIGRATION_EVIDENCE_INCOMPLETE')
  assert.equal(graduationError(null), 'EVIDENCE_UNAVAILABLE')
  assert.equal(TRANSIENT_REVIEW_CODES.includes('EVIDENCE_UNAVAILABLE'), false)
})

test('real PostgreSQL: a failed read never replaces a finding on record, and a finding replaces a failed read', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const { default: pg } = await import('pg')
  const url = new URL(process.env.CHART_TEST_DATABASE_URL)
  assert.equal(url.port, '55441', 'Use the dedicated chart test DB, never the production tunnel')
  const db = new pg.Client({ connectionString: url.href }); await db.connect()
  try {
    await db.query('begin')
    await db.query(`create temporary table graduation_observations(github_repo_id bigint primary key, checked_at timestamptz not null,
      status varchar(32) not null, observation text, reconciliation text, error_code text)`)
    const row = async () => (await db.query('select status, error_code, observation from graduation_observations where github_repo_id = 7')).rows[0]
    await db.query(`insert into graduation_observations values (7, now(), 'VERIFIED', '{"kept":true}', null, null)`)
    await recordGraduationReview(db, '7', 'RPC_UNAVAILABLE')
    assert.deepEqual(await row(), { status: 'REVIEW', error_code: 'RPC_UNAVAILABLE', observation: '{"kept":true}' })
    await recordGraduationReview(db, '7', 'MIGRATION_EVIDENCE_INCOMPLETE')
    assert.equal((await row()).error_code, 'MIGRATION_EVIDENCE_INCOMPLETE')
    await recordGraduationReview(db, '7', 'RPC_DISAGREEMENT')
    assert.equal((await row()).error_code, 'MIGRATION_EVIDENCE_INCOMPLETE', 'the finding stays until a verified pass')
    await recordGraduationReview(db, '7', 'EVIDENCE_UNAVAILABLE')
    assert.equal((await row()).error_code, 'EVIDENCE_UNAVAILABLE', 'a non-transient code is always recorded')
    await recordGraduationReview(db, '8', 'RPC_UNAVAILABLE')
    assert.equal((await db.query('select error_code from graduation_observations where github_repo_id = 8')).rows[0].error_code, 'RPC_UNAVAILABLE')
  } finally { await db.query('rollback'); await db.end() }
})

test('$REPOING\'s graduation panel shows the protocol liquidity the team added by hand; other pools only their own', () => {
  const manual = liquidityTotals().solLamports
  const repoing = publicGraduation(graduationColumns({ now, graduated: true, pool: REPOING_POOL }), now)
  assert.equal(repoing.protocolLiquidityAdded, manual.toString())
  assert.equal(publicGraduation(graduationColumns({ now, graduated: true, pool: REPOING_POOL, protocolLiquidityAdded: '5' }), now).protocolLiquidityAdded,
    (manual + 5n).toString(), 'with verified protocol intents too')
  assert.equal(publicGraduation(graduationColumns({ now, graduated: true, protocolLiquidityAdded: null }), now).protocolLiquidityAdded, null)
  assert.equal(publicGraduation(graduationColumns({ now, graduated: true, protocolLiquidityAdded: '5' }), now).protocolLiquidityAdded, '5')
  assert.equal('protocolLiquidityAdded' in publicGraduation(graduationColumns({ now, reserveSol: 40n }), now), false, 'a curve market shows none')
})
