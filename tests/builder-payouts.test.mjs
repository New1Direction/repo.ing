import test from 'node:test'
import assert from 'node:assert/strict'
import { database, recentBuilderPayouts } from '../app/lib/server.mjs'
const url=new URL(process.env.DATABASE_URL)
assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/repoing_builder_feed','Disposable feed test database required')
const pool=database()
test.after(()=>pool.end())
test('public feed shows only completed payouts from canonical indexed markets, newest first',async()=>{
 await pool.query('truncate repositories cascade')
 await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(1,'test','one','test/one',0,0,false,now()),(2,'test','two','test/two',0,0,false,now())`)
 await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at) values(1,'confirmed','mint1','pool1','launcher','creator','One','ONE','launch1',1,'finalized',now(),now()),(2,'reserved',null,null,'launcher','creator','Two','TWO',null,null,null,null,null)`)
 await pool.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at,resolved_at,resolution_reason) values(1,'receiver',100,'sol','old-settled','settled',now()-interval '1 day',null,null),(1,'receiver',200,'sol','new-settled','settled',now(),null,null),(1,'receiver',300,'sol','pending','pending',null,null,null),(1,'receiver',400,'sol','aborted','aborted',null,now(),'fixture'),(2,'receiver',500,'sol','not-indexed','settled',now(),null,null)`)
 const result=await recentBuilderPayouts()
 assert.equal(result.unavailable,false)
 assert.deepEqual(result.payouts.map(p=>p.signature),['new-settled','old-settled'])
 assert.deepEqual(result.payouts.map(p=>p.amount),['200','100'])
 assert.ok(result.payouts.every(p=>p.fullName==='test/one'&&p.mint==='mint1'&&!('wallet' in p)))
})
