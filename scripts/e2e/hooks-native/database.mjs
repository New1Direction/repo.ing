// A disposable hooks_local_e2e_* database with the production Hook Lab schema and every named migration, in order
// (scripts/hooklab-production-schema.mjs: the bootstrap files, then coin-profiles, wallet-funding, launch-pricing,
// coin-trades and native-stages), created on the local test server and dropped on teardown.
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { MIGRATIONS, migrationSchema, productionSchema } from '../../hooklab-production-schema.mjs'

// The hook *-db tests' local server (scripts/hooks-release-check.sh). CI points this at its own service.
export const ADMIN_URL = process.env.HOOKS_E2E_POSTGRES_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/postgres'

export async function createDatabase({ log }) {
  const admin = new URL(ADMIN_URL)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname)) throw Error('The e2e database server must be loopback')
  const name = `hooks_local_e2e_${randomBytes(6).toString('hex')}`
  const client = new pg.Client({ connectionString: ADMIN_URL })
  await client.connect()
  try { await client.query(`create database ${name}`) } finally { await client.end() }
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: url.href, max: 1 })
  try {
    await pool.query(productionSchema().sql)
    for (const migration of Object.keys(MIGRATIONS)) await pool.query(migrationSchema(migration).sql)
    const tables = (await pool.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n
    const stages = (await pool.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='hook_lab_native_signing_operations_stage_check'")).rows[0].d
    if (!/native-buy/.test(stages) || !/native-claim/.test(stages)) throw Error('native-stages migration did not apply')
    log?.(`database ${name}: production schema + ${Object.keys(MIGRATIONS).join(', ')} (${tables} tables)`)
  } finally { await pool.end() }
  async function drop() {
    const c = new pg.Client({ connectionString: ADMIN_URL })
    await c.connect()
    try {
      await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()', [name])
      await c.query(`drop database if exists ${name}`)
    } finally { await c.end() }
  }
  return { name, url: url.href, drop }
}
