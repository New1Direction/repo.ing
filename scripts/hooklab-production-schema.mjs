#!/usr/bin/env node
// Hook Lab production schema. Prints a self-contained program for `node` inside the web container,
// which reaches the private database (it has no public endpoint):
//
//   node scripts/hooklab-production-schema.mjs check | railway ssh -p <project> -s web -e production -- node
//   node scripts/hooklab-production-schema.mjs apply --sha256 <reviewed> | railway ssh ... -- node
//
// check is read-only (session forced read-only). apply runs every file below in ONE transaction,
// only if none of their tables exist yet, and only for the exact SQL whose sha256 was reviewed.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
// Order from HOOK_NATIVE_LAUNCH_RUNBOOK.md, then quota, expiry and owner approval.
export const SCHEMA_FILES = Object.freeze(['hooklab-wallet-principal-schema.sql', 'hooklab-wallet-preparation-schema.sql', 'hooklab-native-signer-custody-schema.sql',
  'hooklab-new-mint-preparation-schema.sql', 'hooklab-native-signing-schema.sql', 'hooklab-native-signing-attempt-schema.sql', 'hooklab-native-signing-context-schema.sql',
  'hooklab-native-signing-refresh-schema.sql', 'hooklab-native-launch-context-schema.sql', 'hooklab-native-signing-trade-schema.sql',
  'hooklab-native-signing-wallet-request-schema.sql', 'hooklab-wallet-identity-quota-schema.sql', 'hooklab-native-signing-expiry-schema.sql', 'hooklab-owner-approval-schema.sql'])
export function productionSchema() {
  const parts = SCHEMA_FILES.map(name => ({ name, sql: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8') }))
  const sql = parts.map(p => `-- ${p.name}\n${p.sql}`).join('\n')
  const tables = [...new Set(parts.flatMap(p => [...p.sql.matchAll(/create table (?:if not exists )?([a-z_]+)/gi)].map(m => m[1].toLowerCase())))]
  return { sql, sha256: createHash('sha256').update(sql).digest('hex'), tables, files: parts.map(p => ({ name: p.name, sha256: createHash('sha256').update(p.sql).digest('hex') })) }
}
function program({ mode, sql, tables }) {
  return `const {Client}=require('pg');const tables=${JSON.stringify(tables)};const sql=${JSON.stringify(sql)};const mode=${JSON.stringify(mode)}
const c=new Client({connectionString:process.env.DATABASE_URL,options:mode==='check'?'-c default_transaction_read_only=on':undefined})
;(async()=>{try{await c.connect()
 const present=(await c.query("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)",[tables])).rows.map(r=>r.table_name)
 console.log(mode+': '+present.length+' of '+tables.length+' Hook Lab tables already exist'+(present.length?': '+present.sort().join(', '):''))
 if(mode==='check'){process.exitCode=0;return}
 if(present.length){console.log('STOP: some tables exist; nothing applied');process.exitCode=1;return}
 await c.query('begin');try{await c.query(sql);await c.query('commit')}catch(e){await c.query('rollback');throw e}
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
  } else if (mode === 'check') process.stdout.write(program({ mode, ...schema }))
  else if (mode === 'apply' && flag === '--sha256' && value === schema.sha256) process.stdout.write(program({ mode, ...schema }))
  else { console.error(`usage: show | check | apply --sha256 ${schema.sha256}`); process.exit(2) }
}
