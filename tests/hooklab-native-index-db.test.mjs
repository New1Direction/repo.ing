import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { indexHookNativeBatch, hookNativeIndexStore } from '../src/hooklab-native-indexer.mjs'
import { nativeIndexFixture } from './fixtures/hooklab-native-index.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

test('durable native index atomically checkpoints, survives restart and rejects competing writers', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `hook_index_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await pool.query(readFileSync(new URL('../src/hooklab-native-index-schema.sql', import.meta.url), 'utf8'))
    const f = nativeIndexFixture()
    await pool.query("alter table hook_native_index_transactions add constraint reject_fixture check(slot <> 102)")
    await assert.rejects(indexHookNativeBatch({ ...f, store: hookNativeIndexStore(pool) }), /reject_fixture/)
    assert.equal((await pool.query('select next_slot from hook_native_index_streams')).rows[0].next_slot, '100')
    assert.equal((await pool.query('select count(*) from hook_native_index_blocks')).rows[0].count, '0')
    await pool.query('alter table hook_native_index_transactions drop constraint reject_fixture')
    const outcomes = await Promise.allSettled([1, 2].map(() => indexHookNativeBatch({ ...f, store: hookNativeIndexStore(pool) })))
    assert.ok(outcomes.some(o => o.status === 'fulfilled'))
    assert.equal((await pool.query('select count(*) from hook_native_index_transactions')).rows[0].count, '2')
    const retained = (await pool.query('select evidence from hook_native_index_transactions order by slot')).rows
    await pool.end(); pool = new pg.Pool({ ...config, database })
    assert.equal((await indexHookNativeBatch({ ...f, store: hookNativeIndexStore(pool) })).status, 'caught-up')
    assert.deepEqual((await pool.query('select evidence from hook_native_index_transactions order by slot')).rows, retained)
    const original = f.adapters[0].read
    f.adapters[0].read = async (m, p) => m === 'getSlot' ? 103 : m === 'getBlocks' ? [103] : m === 'getBlock' ? null : original(m, p)
    f.adapters[1].read = async (...args) => f.adapters[0].read(...args)
    await assert.rejects(indexHookNativeBatch({ ...f, store: hookNativeIndexStore(pool) }), /Missing/)
    assert.equal((await pool.query('select next_slot from hook_native_index_streams')).rows[0].next_slot, '103')
    assert.deepEqual((await pool.query('select evidence from hook_native_index_transactions order by slot')).rows, retained)
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database)
    await admin.end()
  }
})
