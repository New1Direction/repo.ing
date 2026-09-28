import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createMarketNotifications } from '../src/market-notifications.mjs'
const url=process.env.TEST_DATABASE_URL
const local=url && new URL(url).hostname==='127.0.0.1' && new URL(url).port==='55441'
test('committed indexed evidence notifies; rollback, unknown and unfinalized markets do not', {skip:!local},async()=>{
  const db=new pg.Client({connectionString:url});await db.connect()
  const schema=`market_update_test_${randomBytes(5).toString('hex')}`
  const mint='59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
  const seen=[];let hub
  async function waitFor(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.fail('notification timed out')}
  try{
    await db.query(`create schema ${schema};set search_path to ${schema};create table markets(github_repo_id bigint primary key,mint text,pool text,status text,indexed_at timestamptz,launch_finality text);create table trade_events(pool text);create table damm_trade_events(github_repo_id bigint);create table graduation_observations(github_repo_id bigint)`)
    await db.query(await readFile(new URL('../drizzle/0023_market_update_notifications.sql',import.meta.url),'utf8'))
    await db.query("insert into markets values(1,$1,'pool','confirmed',now(),'finalized'),(2,$1,'unfinalized','confirmed',now(),'confirmed')",[mint])
    hub=createMarketNotifications({connectionString:url});const stop=hub.subscribe(mint,e=>seen.push(e))
    await waitFor(()=>seen.length===1);assert.equal(seen[0].kind,'resync');seen.length=0
    await db.query("begin;insert into trade_events values('pool');rollback;insert into trade_events values('unknown'),('unfinalized')")
    await new Promise(r=>setTimeout(r,40));assert.equal(seen.length,0)
    await db.query("begin;insert into trade_events values('pool');insert into trade_events values('pool')")
    await new Promise(r=>setTimeout(r,30));assert.equal(seen.length,0)
    await db.query('commit');await waitFor(()=>seen.length===1);assert.deepEqual(seen[0],{mint,kind:'trade'})
    await db.query('insert into damm_trade_events values(1);insert into graduation_observations values(1)');await waitFor(()=>seen.length===3)
    assert.deepEqual(seen.map(x=>x.kind),['trade','trade','curve'])
    stop();hub.close();hub=null
  }finally{hub?.close();await db.query(`drop schema ${schema} cascade`);await db.end()}
})
