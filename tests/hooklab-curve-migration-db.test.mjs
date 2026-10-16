import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

test('unregistered curve schema rolls back collisions and preserves registered ledger and plain recovery', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', database: 'postgres' }
  const admin = new pg.Pool(config), database = `curve_migration_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    const ledger = (await pool.query('select * from drizzle.__drizzle_migrations order by id')).rows
    const id = randomUUID()
    await pool.query(`insert into hook_lab_plain_recovery(id,github_user_id,genesis_hash,mint,message_sha256,plan)
      values($1,101,'synthetic-genesis','synthetic-mint',$2,'{"retained":"plain-sentinel"}')`, [id, 'a'.repeat(64)])
    await pool.query("insert into hook_lab_plain_events(journal_id,kind,outcome) values($1,'prepared','{\"retained\":true}')", [id])
    const plain = (await pool.query('select * from hook_lab_plain_recovery')).rows
    const events = (await pool.query('select * from hook_lab_plain_events')).rows
    const sql = readFileSync(new URL('../src/hooklab-curve-schema.sql', import.meta.url), 'utf8')
    const apply = async () => {
      const db = await pool.connect()
      try { await db.query('begin'); await db.query("set local lock_timeout='5s'"); await db.query(sql); await db.query('commit') }
      catch (error) { await db.query('rollback'); throw error }
      finally { db.release() }
    }
    // Last table deliberately collides: the earlier six tables must roll back as a unit.
    await pool.query('create table hook_lab_curve_alert_reviews(sentinel text)')
    await pool.query("insert into hook_lab_curve_alert_reviews values('existing table, never replace')")
    await assert.rejects(apply(), /already exists/)
    assert.deepEqual((await pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'hook_lab_curve_%'")).rows,
      [{ tablename: 'hook_lab_curve_alert_reviews' }])
    assert.deepEqual((await pool.query('select * from hook_lab_curve_alert_reviews')).rows, [{ sentinel: 'existing table, never replace' }])
    await pool.query('drop table hook_lab_curve_alert_reviews') // Disposable collision fixture only.
    await apply()
    await assert.rejects(apply(), /already exists/) // No IF NOT EXISTS hides partially adopted schema.
    assert.equal((await pool.query("select count(*) from pg_tables where schemaname='public' and tablename like 'hook_lab_curve_%'")).rows[0].count, '7')
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    assert.deepEqual((await pool.query('select * from drizzle.__drizzle_migrations order by id')).rows, ledger)
    assert.deepEqual((await pool.query('select * from hook_lab_plain_recovery')).rows, plain)
    assert.deepEqual((await pool.query('select * from hook_lab_plain_events')).rows, events)
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
