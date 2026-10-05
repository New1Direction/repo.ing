import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { createBuilderReminders, reminderPlan, reminderEmail, reminderToken, verifyReminderToken, remindersConfigured, createReminderSender } from '../src/builder-reminders.mjs'
const secret='test-only-reminder-secret-at-least-32-bytes'
test('reminder threshold, newly earned fees, pending claims and wallet changes',()=>{
 const row={repoId:'1',wallet:'a',status:'MATCH',available:'50000000',earned:'70000000'}
 assert.equal(reminderPlan([row]).notify,true)
 assert.equal(reminderPlan([{...row,status:'MISMATCH'}]).notify,false)
 assert.equal(reminderPlan([{...row,status:'PENDING_REVIEW'}]).notify,false)
 assert.equal(reminderPlan([{...row,available:'0'}]).notify,false)
 assert.equal(reminderPlan([row],{'1:a':'70000000'}).notify,false)
 assert.equal(reminderPlan([row],{'1:b':'70000000'}).notify,true)
 assert.equal(reminderPlan([{...row,available:'49999999'}]).notify,false)
 assert.equal(reminderEmail(' Example@domain.com '),'example@domain.com')
 assert.throws(()=>reminderEmail('a@b.com\r\nbcc:x@y.com'))
 assert.equal(remindersConfigured({BUILDER_REMINDERS_ENABLED:'true'}),false)
 assert.equal(createReminderSender({}),null)
})
test('confirmation and unsubscribe tokens bind account, revision and purpose',()=>{
 const row={github_user_id:'1',revision:'a'.repeat(32)},token=reminderToken(row,'confirm',secret)
 assert.equal(verifyReminderToken(token,row,'confirm',secret),true)
 assert.equal(verifyReminderToken(token,row,'unsubscribe',secret),false)
 assert.equal(verifyReminderToken(token,{...row,github_user_id:'2'},'confirm',secret),false)
 assert.equal(verifyReminderToken(token,{...row,revision:'b'.repeat(32)},'confirm',secret),false)
})
test('real PostgreSQL: explicit confirmation, immutable retries, daily cap, no repeats and removal', {skip:!process.env.CHART_TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.CHART_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55441')
 const db=new pg.Client({connectionString:url.href});await db.connect();await db.query('begin')
 const pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})}
 let now=Date.parse('2026-09-27T00:00:00Z'),fail=false;const emails=[]
 let fees={status:'MATCH',onchainCreatorFee:100000000n,recordedEarned:100000000n}
 const service=createBuilderReminders({pool,secret,origin:'https://repo.ing',now:()=>now,reconcile:async()=>fees,send:async m=>{emails.push(m);if(fail)throw Error('timeout');return 'accepted'}})
 try{
 await db.query(readFileSync('drizzle/0021_builder_reminders.sql','utf8').replaceAll('CREATE TABLE','CREATE TEMPORARY TABLE'))
 await db.query('create temporary table repo_beneficiaries(github_repo_id bigint,github_user_id bigint,wallet text);create temporary table markets(github_repo_id bigint,mint text,status text,launch_finality text,indexed_at timestamptz,quote_asset_id text,early_access_end timestamptz);create temporary table repositories(github_repo_id bigint,full_name text)')
 await db.query("insert into repo_beneficiaries values(1,7,'wallet');insert into markets values(1,'mint','confirmed','finalized',now());insert into repositories values(1,'owner/repo')")
 await service.subscribe('7','owner@example.com');assert.equal((await service.status('7')).status,'pending')
 assert.equal((await service.runOnce()).accepted,0);assert.equal(emails.length,1)
 await assert.rejects(service.subscribe('7','owner@example.com'),/ten minutes/)
 const row=(await db.query('select * from builder_reminders')).rows[0]
 const token=reminderToken(row,'confirm',secret)
 await assert.rejects(service.act(token,'unsubscribe'),/invalid/)
 await assert.rejects(service.subscribe('8','owner@example.com'),/ten minutes/)
 await service.act(token,'confirm');assert.equal((await service.status('7')).status,'active')
 // Move database scheduling into the deterministic test clock.
 await db.query('update builder_reminders set next_check_at=$1',[new Date(now)])
 fail=true;assert.equal((await service.runOnce()).failed,1)
 const pending=(await db.query('select delivery from builder_reminders')).rows[0].delivery
 const original=JSON.parse(pending).message
 now+=600001;fail=false;fees={...fees,onchainCreatorFee:900000000n,recordedEarned:900000000n}
 assert.equal((await service.runOnce()).accepted,1);assert.deepEqual(emails.at(-1),original)
 assert.equal((await service.runOnce()).accepted,0)
 now+=86400001;assert.equal((await service.runOnce()).accepted,1)
 now+=86400001;assert.equal((await service.runOnce()).accepted,0)
 await service.act(reminderToken(row,'unsubscribe',secret),'unsubscribe')
 assert.equal((await service.status('7')).status,'off')
 assert.equal((await db.query('select count(*)::int n from builder_reminders')).rows[0].n,0)
 await assert.rejects(service.act(token,'confirm'),/invalid/)
 }finally{await db.query('rollback');await db.end()}
})
