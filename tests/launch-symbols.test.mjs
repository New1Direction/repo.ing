import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SYMBOL_REVIEW_STATUSES, SYMBOL_SENT_STATUSES, SymbolTakenError, TICKER_MESSAGE, assertSymbolFree, symbolHolder, validTicker, withSymbolLock } from '../src/launch-symbols.mjs'
import { RAISE_REFUSALS, tokenFields } from '../src/bundle-raise.mjs'
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
  assert.match(sql, /from markets m where lower\(m\.token_symbol\) = lower\(\$1\) and m\.github_repo_id <> \$2::bigint and m\.status = any\(\$3::text\[\]\)/)
  // A market its maintainer declined does not hold its ticker (relaunch from a new repository, owner decision 2026-10-09).
  assert.match(sql, /and not exists \(select 1 from maintainer_opt_outs o where o\.github_repo_id = m\.github_repo_id and o\.withdrawn_at is null\)/)
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

test('tickers are ASCII letters and digits on the server too, so lookalikes cannot dodge the one-ticker rule', () => {
  for (const symbol of ['REPOING', 'omarchy', 'GPT2', 'A', 'ABCDEFGHIJ']) assert.ok(validTicker(symbol), symbol)
  // A trailing space, a zero-width space, a Cyrillic І, a dollar sign, an emoji, an accented letter, eleven characters, none.
  for (const symbol of ['REPOING ', 'REPO\u200bING', 'REPO\u0406NG', '$REPO', 'REPO\u{1F680}', 'ÜÑ', 'ABCDEFGHIJK', '', null, 7]) {
    assert.equal(validTicker(symbol), false, JSON.stringify(symbol))
  }
  assert.equal(TICKER_MESSAGE, 'Ticker must be 1–10 letters or numbers (A–Z, 0–9).')
  // A Bundle raise opens with the same rule.
  assert.throws(() => tokenFields({ tokenName: 'Widget', tokenSymbol: 'REPO\u0406NG' }), { message: RAISE_REFUSALS.tokenSymbol })
  assert.deepEqual(tokenFields({ tokenName: 'Widget', tokenSymbol: 'wdgt' }), { tokenName: 'Widget', tokenSymbol: 'wdgt' })
})
