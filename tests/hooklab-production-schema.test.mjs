// The production schema script: the applied bootstrap stays byte-identical, and later tables ship as named
// migrations that apply only for their reviewed sha256 and only while their tables are absent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { MIGRATIONS, migrationSchema, productionSchema } from '../scripts/hooklab-production-schema.mjs'

const script = new URL('../scripts/hooklab-production-schema.mjs', import.meta.url).pathname
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

test('the reviewed bootstrap is unchanged', () => {
  assert.equal(productionSchema().sha256, '2e4968864c9deaf3c8a03f8732cc0bd353c86e195835907c348398fd029f55b0')
  assert.ok(!productionSchema().tables.includes('hook_lab_coin_profiles'))
})

test('coin-profiles is a separate migration for one new table', () => {
  assert.deepEqual(Object.keys(MIGRATIONS), ['coin-profiles', 'wallet-funding', 'launch-pricing', 'coin-trades'])
  const migration = migrationSchema('coin-profiles')
  assert.deepEqual(migration.tables, ['hook_lab_coin_profiles'])
  assert.deepEqual(migration.requires, ['hook_lab_launch_requests'])
  assert.match(migration.sha256, /^[0-9a-f]{64}$/)
  assert.throws(() => migrationSchema('nope'), /Unknown migration/)
})

test('migrate prints a program only for the reviewed sha256; check is read-only', () => {
  const { sha256 } = migrationSchema('coin-profiles')
  const refused = run('migrate', 'coin-profiles', '--sha256', '0'.repeat(64))
  assert.equal(refused.status, 2); assert.equal(refused.stdout, ''); assert.match(refused.stderr, new RegExp(sha256))
  const applied = run('migrate', 'coin-profiles', '--sha256', sha256)
  assert.equal(applied.status, 0); assert.match(applied.stdout, /create table hook_lab_coin_profiles/); assert.match(applied.stdout, /const mode="apply"/)
  const checked = run('migration-check', 'coin-profiles')
  assert.equal(checked.status, 0); assert.match(checked.stdout, /default_transaction_read_only=on/); assert.match(checked.stdout, /const mode="check"/)
})

test('wallet-funding only widens the signing stage list, idempotently, and shows the constraint', () => {
  const migration = migrationSchema('wallet-funding')
  assert.deepEqual(migration.tables, []); assert.deepEqual(migration.requires, ['hook_lab_native_signing_operations'])
  assert.match(migration.sql, /drop constraint if exists hook_lab_native_signing_operations_stage_check/)
  assert.match(migration.sql, /'preparation','launch','inclusive-buy','inclusive-sell','wallet-fund','wallet-withdraw'/)
  assert.doesNotMatch(migration.sql, /drop table|delete|update /i)
  assert.match(run('migration-check', 'wallet-funding').stdout, /stage_check/)
})

test('launch-pricing adds one insert-only price table per launch request', () => {
  const migration = migrationSchema('launch-pricing')
  assert.deepEqual(migration.tables, ['hook_lab_launch_request_prices']); assert.deepEqual(migration.requires, ['hook_lab_launch_requests'])
  assert.match(migration.sql, /request_id uuid primary key references hook_lab_launch_requests\(id\)/)
  assert.match(migration.sql, /before update or delete on hook_lab_launch_request_prices/)
  assert.doesNotMatch(migration.sql, /drop |alter table hook_lab_launch_requests/i, 'the existing request table is untouched')
  assert.ok(!productionSchema().tables.includes('hook_lab_launch_request_prices'), 'not part of the reviewed bootstrap')
  const applied = run('migrate', 'launch-pricing', '--sha256', migration.sha256)
  assert.equal(applied.status, 0); assert.match(applied.stdout, /create table hook_lab_launch_request_prices/)
})

test('coin-trades adds the trade index and its cursors, and nothing else', () => {
  const migration = migrationSchema('coin-trades')
  assert.deepEqual(migration.tables, ['hook_lab_coin_trades', 'hook_lab_coin_trade_cursors']); assert.deepEqual(migration.requires, [])
  assert.match(migration.sql, /primary key\(signature,event_index\)/); assert.match(migration.sql, /unique\(pool,swap_count\)/)
  assert.doesNotMatch(migration.sql, /drop |delete|update |alter /i)
  assert.ok(!productionSchema().tables.includes('hook_lab_coin_trades'), 'not part of the applied bootstrap')
  assert.match(run('migration-check', 'coin-trades').stdout, /const mode="check"/)
})
