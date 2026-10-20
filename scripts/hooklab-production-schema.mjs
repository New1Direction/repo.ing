#!/usr/bin/env node
// Hook Lab production schema. Prints a self-contained program for `node` inside the web container,
// which reaches the private database (it has no public endpoint):
//
//   node scripts/hooklab-production-schema.mjs check | railway ssh -p <project> -s web -e production -- node
//   node scripts/hooklab-production-schema.mjs apply --sha256 <reviewed> | railway ssh ... -- node
//
// check is read-only (session forced read-only). apply runs every file below in ONE transaction,
// only if none of their tables exist yet, and only for the exact SQL whose sha256 was reviewed.
//
// Tables added after the bootstrap ship as named migrations, applied the same way and only once
// the tables they reference exist:
//
//   node scripts/hooklab-production-schema.mjs migration-check coin-profiles | railway ssh ... -- node
//   node scripts/hooklab-production-schema.mjs migrate coin-profiles --sha256 <reviewed> | railway ssh ... -- node
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
// Order from HOOK_NATIVE_LAUNCH_RUNBOOK.md, then quota, expiry and owner approval.
export const SCHEMA_FILES = Object.freeze(['hooklab-wallet-principal-schema.sql', 'hooklab-wallet-preparation-schema.sql', 'hooklab-native-signer-custody-schema.sql',
  'hooklab-new-mint-preparation-schema.sql', 'hooklab-native-signing-schema.sql', 'hooklab-native-signing-attempt-schema.sql', 'hooklab-native-signing-context-schema.sql',
  'hooklab-native-signing-refresh-schema.sql', 'hooklab-native-launch-context-schema.sql', 'hooklab-native-signing-trade-schema.sql',
  'hooklab-native-signing-wallet-request-schema.sql', 'hooklab-wallet-identity-quota-schema.sql', 'hooklab-native-signing-expiry-schema.sql', 'hooklab-owner-approval-schema.sql'])
// name -> { files, requires, inspect }: requires lists existing tables the migration references; inspect (optional) is a
// read-only query whose rows are printed by check and apply, for migrations that change constraints rather than add tables.
export const MIGRATIONS = Object.freeze({
  'coin-profiles': Object.freeze({ files: ['hooklab-coin-profile-schema.sql'], requires: ['hook_lab_launch_requests'] }),
  'wallet-funding': Object.freeze({ files: ['hooklab-native-signing-funding-schema.sql'], requires: ['hook_lab_native_signing_operations'],
    inspect: "select pg_get_constraintdef(oid) as stage_check from pg_constraint where conname='hook_lab_native_signing_operations_stage_check'" }),
  // Apply before turning on HOOK_LAUNCH_USD_PRICING; with the flag off nothing reads or writes this table.
  'launch-pricing': Object.freeze({ files: ['hooklab-launch-pricing-schema.sql'], requires: ['hook_lab_launch_requests'] }),
  // The Hooks coin page's trade index (src/hooklab-coin-trades.mjs): two new tables that reference nothing.
  'coin-trades': Object.freeze({ files: ['hooklab-coin-trades-schema.sql'], requires: [] }),
  // Native-SOL trades and creator claims: widens the signing stage list. Apply before the native routes are switched on.
  'native-stages': Object.freeze({ files: ['hooklab-native-signing-native-schema.sql'], requires: ['hook_lab_native_signing_operations'],
    inspect: "select pg_get_constraintdef(oid) as stage_check from pg_constraint where conname='hook_lab_native_signing_operations_stage_check'" }),
  // Self-serve launches and coin moderation: the request source, the owner-invite-only single-invite index and the
  // append-only moderation record. Apply before HOOK_OPEN_LAUNCHES=true.
  'open-launches': Object.freeze({ files: ['hooklab-open-launch-schema.sql'], requires: ['hook_lab_launch_requests', 'hook_lab_launch_request_prices'],
    inspect: "select indexdef from pg_indexes where indexname='hook_lab_launch_requests_single_invite'" }),
  // Durable custom-hook coin recording only; this does not enable preparation or signing.
  'selected-hook-requests': Object.freeze({ files: ['hooklab-selected-hook-requests-schema.sql'], requires: ['hook_lab_launch_requests'],
    inspect: "select column_name from information_schema.columns where table_name='hook_lab_launch_requests' and column_name in ('source','selected_hook') order by column_name" }),
  'selected-hook-execution': Object.freeze({ files: ['hooklab-selected-hook-execution-schema.sql'], requires: ['hook_lab_launch_requests'],
    inspect: "select pg_get_constraintdef(oid) as selected_check from pg_constraint where conname='hook_lab_launch_requests_selected_execution'" }),
})
export function productionSchema(files = SCHEMA_FILES) {
  const parts = files.map(name => ({ name, sql: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8') }))
  const sql = parts.map(p => `-- ${p.name}\n${p.sql}`).join('\n')
  const tables = [...new Set(parts.flatMap(p => [...p.sql.matchAll(/create table (?:if not exists )?([a-z_]+)/gi)].map(m => m[1].toLowerCase())))]
  return { sql, sha256: createHash('sha256').update(sql).digest('hex'), tables, files: parts.map(p => ({ name: p.name, sha256: createHash('sha256').update(p.sql).digest('hex') })) }
}
export function migrationSchema(name) {
  const migration = Object.hasOwn(MIGRATIONS, name) ? MIGRATIONS[name] : null
  if (!migration) throw Error(`Unknown migration ${name}; known: ${Object.keys(MIGRATIONS).join(', ')}`)
  return { ...productionSchema(migration.files), requires: [...migration.requires], inspect: migration.inspect ?? null }
}
function program({ mode, sql, tables, requires = [], inspect = null }) {
  return `const {Client}=require('pg');const tables=${JSON.stringify(tables)};const requires=${JSON.stringify(requires)};const sql=${JSON.stringify(sql)};const mode=${JSON.stringify(mode)};const inspect=${JSON.stringify(inspect)}
const c=new Client({connectionString:process.env.DATABASE_URL,options:mode==='check'?'-c default_transaction_read_only=on':undefined})
;(async()=>{try{await c.connect()
 const ready=requires.length?(await c.query("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)",[requires])).rows.length:0
 if(requires.length)console.log(mode+': '+ready+' of '+requires.length+' required tables exist ('+requires.join(', ')+')')
 if(mode!=='check'&&ready!==requires.length){console.log('STOP: required tables are missing; nothing applied');process.exitCode=1;return}
 const show=async when=>{if(inspect)for(const row of (await c.query(inspect)).rows)console.log(when+': '+JSON.stringify(row))}
 await show(mode==='check'?'current':'before')
 const present=(await c.query("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)",[tables])).rows.map(r=>r.table_name)
 console.log(mode+': '+present.length+' of '+tables.length+' Hook Lab tables already exist'+(present.length?': '+present.sort().join(', '):''))
 if(mode==='check'){process.exitCode=0;return}
 if(present.length){console.log('STOP: some tables exist; nothing applied');process.exitCode=1;return}
 await c.query('begin');try{await c.query(sql);await c.query('commit')}catch(e){await c.query('rollback');throw e}
 await show('after')
 const after=(await c.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_name = any($1)",[tables])).rows[0].n
 console.log('applied in one transaction: '+after+' of '+tables.length+' tables now exist')
}catch(e){console.log('ERROR (nothing committed): '+e.message);process.exitCode=1}finally{await c.end()}})()
`
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, flag, value] = process.argv.slice(2), schema = productionSchema()
  if (mode === 'show') {
    console.error(`sha256 ${schema.sha256} (${schema.files.length} files, ${schema.tables.length} tables)`)
    for (const f of schema.files) console.error(`  ${f.sha256.slice(0, 16)}  ${f.name}`)
    console.error(`tables: ${schema.tables.join(', ')}`)
    for (const name of Object.keys(MIGRATIONS)) {
      const migration = migrationSchema(name)
      console.error(`migration ${name}: sha256 ${migration.sha256} (tables: ${migration.tables.join(', ')}; requires: ${migration.requires.join(', ')})`)
    }
  } else if (mode === 'check') process.stdout.write(program({ mode, ...schema }))
  else if (mode === 'apply' && flag === '--sha256' && value === schema.sha256) process.stdout.write(program({ mode, ...schema }))
  else if ((mode === 'migration-check' || mode === 'migrate') && Object.hasOwn(MIGRATIONS, flag)) {
    const migration = migrationSchema(flag), [shaFlag, sha] = process.argv.slice(4)
    if (mode === 'migration-check') process.stdout.write(program({ mode: 'check', ...migration }))
    else if (shaFlag === '--sha256' && sha === migration.sha256) process.stdout.write(program({ mode: 'apply', ...migration }))
    else { console.error(`usage: migrate ${flag} --sha256 ${migration.sha256}`); process.exit(2) }
  }
  else { console.error(`usage: show | check | apply --sha256 ${schema.sha256} | migration-check <name> | migrate <name> --sha256 <sha>`); process.exit(2) }
}
