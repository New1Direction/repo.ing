import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SYMBOL_REVIEW_STATUSES, SYMBOL_SENT_STATUSES, SymbolTakenError, assertSymbolFree, symbolHolder, withSymbolLock } from '../src/launch-symbols.mjs'
import { LIVE_BUNDLE_STATUSES } from '../src/bundle-raise-store.mjs'
import { launchFailure } from '../src/launch-failure.mjs'

// One ticker per market (owner decision 2026-10-08), the parts that need no database: the query's shape, the refusal and how the
// launch API answers it. The rule end to end on PostgreSQL (case, review/sent/bundle holders, the race at sending, a bundle's own
// launch) is in tests/launch-coordinator.test.mjs; the bundle opening in tests/bundle-raise.test.mjs.
const recorder = rows => {
  const asked = []
  return { asked, query: async (sql, params) => { asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows } } }
}

test('the ticker is compared without case, against other repositories only, over markets and live bundles', async () => {
  const db = recorder([])
  assert.equal(await symbolHolder(db, { symbol: 'Omarchy', githubRepoId: 123n }), null)
  const [{ sql, params }] = db.asked
  assert.match(sql, /from markets where lower\(token_symbol\) = lower\(\$1\) and github_repo_id <> \$2::bigint and status = any\(\$3::text\[\]\)/)
  assert.match(sql, /from bundles where lower\(token_symbol\) = lower\(\$1\) and github_repo_id <> \$2::bigint and status = any\(\$4::text\[\]\)/)
  assert.deepEqual(params, ['Omarchy', '123', ['prepared', 'submitted', 'ambiguous', 'confirmed'], [...LIVE_BUNDLE_STATUSES]])
  // Failed attempts and expired or failed bundles never hold a ticker; a review in progress does until it is sent or released.
  assert.deepEqual([...SYMBOL_REVIEW_STATUSES], ['prepared', 'submitted', 'ambiguous', 'confirmed'])
  assert.deepEqual([...SYMBOL_SENT_STATUSES], ['submitted', 'ambiguous', 'confirmed'])
  assert.ok(!LIVE_BUNDLE_STATUSES.includes('failed') && !LIVE_BUNDLE_STATUSES.includes('expired'))
  await symbolHolder(db, { symbol: 'x', githubRepoId: '1', statuses: SYMBOL_SENT_STATUSES })
  assert.deepEqual(db.asked[1].params[2], ['submitted', 'ambiguous', 'confirmed'])
})

test('a taken ticker is refused with the holder\'s spelling and a fix the builder can make', async () => {
  await assert.rejects(assertSymbolFree(recorder([{ takenSymbol: 'OMARCHY' }]), { symbol: 'omarchy', githubRepoId: '9' }), error =>
    error instanceof SymbolTakenError && error.code === 'SYMBOL_TAKEN' &&
    error.message === 'The ticker $OMARCHY is already used by another market on repo.ing. Choose a different ticker.')
  await assertSymbolFree(recorder([]), { symbol: 'omarchy', githubRepoId: '9' })
})

test('the launch API answers it as a refusal to fix and review again, at review and just before sending', () => {
  const error = new SymbolTakenError('OMARCHY')
  for (const action of ['prepare', 'submit']) {
    assert.deepEqual(launchFailure(error, action), { error: error.message, canRetry: true, code: 'SYMBOL_TAKEN' }, action)
  }
})

test('the ticker lock wraps the work and is released when it fails', async () => {
  const db = recorder([])
  await assert.rejects(withSymbolLock(db, 'OmArChY', async () => { await db.query('work'); throw Error('refused') }), /refused/)
  assert.deepEqual(db.asked.map(({ sql, params }) => [sql, params]), [
    ['select pg_advisory_lock(hashtextextended($1,0))', ['launch-symbol:omarchy']], ['work', undefined],
    ['select pg_advisory_unlock(hashtextextended($1,0))', ['launch-symbol:omarchy']]])
})

test('every launch the API reviews or submits asks for the check; nothing else changes', () => {
  const route = readFileSync(new URL('../app/api/launch/route.js', import.meta.url), 'utf8')
  const coordinators = route.match(/createLaunchCoordinator\(\{[\s\S]*?\}\)(?=\s*\n)/g)
  assert.equal(coordinators.length, 3, 'model review, repository review, submit')
  for (const call of coordinators) assert.match(call, /refuseTakenSymbols: true/)
})
