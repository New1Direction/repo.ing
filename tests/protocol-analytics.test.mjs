import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { analyticsWindow, readProtocolAnalytics, TEAM_REPO_IDS, TEAM_REPO_OWNERS } from '../src/protocol-analytics.mjs'

test('analytics periods have exact rolling bounds; all-time charts show 14 UTC days', () => {
  const now = new Date('2026-09-27T12:00:00Z')
  assert.equal(analyticsWindow('24h', now).since, '2026-09-26T12:00:00.000Z')
  assert.equal(analyticsWindow('7d', now).since, '2026-09-20T12:00:00.000Z')
  assert.equal(analyticsWindow('30d', now).since, '2026-08-28T12:00:00.000Z')
  assert.equal(analyticsWindow('all', now).chartSince, '2026-09-14T00:00:00.000Z')
  assert.equal(analyticsWindow('invalid', now).range, 'all')
})

test('public analytics: canonical DBC/DAMM evidence, UTC periods, settled payouts and fail-closed reserves', async () => {
  const url = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_analytics_test'
  assert.equal(process.env.DATABASE_URL,url)
  const admin = new pg.Pool({connectionString:url.replace('/repoing_analytics_test','/postgres')});let pool,created=false
  try {
    await admin.query('create database repoing_analytics_test');created=true
    pool=new pg.Pool({connectionString:url});await migrate(drizzle(pool),{migrationsFolder:'drizzle'})
    for(const id of [998300,998301]){
      await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values($1,'local',$2,$3,1,0,false,now())",[id,String(id),`local/${id}`])
      await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at) values($1,'confirmed',$2,$3,'wallet','creator','Fixture','FIX',$4,10,'finalized',$5,now())",[id,`mint${id}`,`pool${id}`,`launch${id}`,id===998300?new Date():null])
    }
    // A repo.ing team repository (owner matched case-insensitively): its builder fees and payouts count in the totals and
    // in the team column, never as outside builders.
    assert.deepEqual(TEAM_REPO_OWNERS, ['New1Direction'])
    await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(998302,'new1direction','team','new1direction/team',1,0,false,now())")
    await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at) values(998302,'confirmed','mint998302','pool998302','wallet','creator','Team','TEAM','launch998302',10,'finalized',now(),now())")
    await pool.query("insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot,created_at) values(998302,'mint998302','pool998302','team-fee',0,400000000,'So11111111111111111111111111111111111111112','dbc_creator_quote',10,'2026-09-27T09:00:00Z')")
    await pool.query("insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at) values(998302,'team',300000000,'So11111111111111111111111111111111111111112','team-paid','settled','2026-09-27T09:30:00Z')")
    // A team repository whose owner changed (renamed organization or transfer) still counts as team, by its repository id.
    assert.deepEqual(TEAM_REPO_IDS, ['1388219884', '1250482335', '1269625283', '1266706783'])
    await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(1250482335,'renamed-org','moved','renamed-org/moved',1,0,false,now())")
    await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at) values(1250482335,'confirmed','mint-moved','pool-moved','wallet','creator','Moved','MOVED','launch-moved',10,'finalized',now(),now())")
    await pool.query("insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot,created_at) values(1250482335,'mint-moved','pool-moved','moved-fee',0,100000000,'So11111111111111111111111111111111111111112','dbc_creator_quote',10,'2026-09-27T08:00:00Z')")
    await pool.query("insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation) values(998300,'migration','damm',10,'hash','{}','{}')")
    for(const [poolName,sig,time,direction,input,output] of [
      ['pool998300','trade1','2026-09-27T10:00:00Z','buy','2000000000','100'],
      ['pool998300','trade2','2026-09-17T10:00:00Z','sell','100','1000000000'],
      ['pool998301','unindexed','2026-09-27T10:00:00Z','buy','99000000000','100']])
      await pool.query('insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price) values($1,$2,0,10,$3,$4,$5,$6,1)',[poolName,sig,time,direction,input,output])
    for(const [poolName,sig,amount] of [['damm','damm-good','3000000000'],['wrong-pool','damm-wrong','9000000000']])
      await pool.query("insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence) values(998300,$1,$2,0,10,'2026-09-27T11:00:00Z',$3,'buy','{}')",[poolName,sig,amount])
    for(const [id,sig,time,amount] of [[998300,'fee1','2026-09-27T10:00:00Z','100000000'],[998300,'fee2','2026-09-17T10:00:00Z','50000000'],[998301,'unindexed-fee','2026-09-27T10:00:00Z','1000000000']])
      await pool.query("insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot,created_at) values($1,$2,$3,$4,0,$5,'So11111111111111111111111111111111111111112','dbc_creator_quote',10,$6)",[id,`mint${id}`,`pool${id}`,sig,amount,time])
    await pool.query("insert into damm_fee_events(github_repo_id,pool,position,slot,amount_base_units,cumulative_earned,cumulative_claimed,evidence_hash,evidence,created_at) values(998300,'damm','position',10,20000000,20000000,0,'hash','{}','2026-09-27T11:00:00Z')")
    await pool.query("insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at) values(998300,'builder',80000000,'So11111111111111111111111111111111111111112','paid','settled','2026-09-27T11:00:00Z'),(998300,'builder',30000000,'So11111111111111111111111111111111111111112','pending','pending',null)")
    await pool.query("insert into platform_revenue_policies(version,buyback_permille,liquidity_permille,activated_at,created_by) values(1,600,200,now(),'fixture')")
    await pool.query("insert into platform_fee_claims(github_repo_id,pool,wallet,amount,status,signature,signed_transaction,last_valid_block_height,settled_at) values(998300,'damm','partner',1000000000,'settled','platform-paid','PRIVATE-SIGNED-DATA',100,now())")
    await pool.query("insert into platform_revenue_allocations(allocation_group,claim_signature,github_repo_id,claimed_amount,buyback_amount,liquidity_amount,treasury_amount,policy_version,created_by) values('fixture','platform-paid',998300,1000000000,600000000,200000000,200000000,1,'fixture')")
    const now=new Date('2026-09-27T12:00:00Z'), all=await readProtocolAnalytics(pool,{now}), day=await readProtocolAnalytics(pool,{now,range:'24h'})
    assert.deepEqual(all.totals,{volume:'6000000000',earned:'670000000',paid:'380000000',trades:3,markets:3,graduated:1})
    assert.deepEqual(all.builders,{earned:{outside:'170000000',team:'500000000'},paid:{outside:'80000000',team:'300000000'}})
    assert.equal(day.totals.volume,'5000000000');assert.equal(day.totals.earned,'620000000')
    assert.deepEqual(day.builders,{earned:{outside:'120000000',team:'500000000'},paid:{outside:'80000000',team:'300000000'}})
    assert.equal(all.days.length,14);assert.equal(day.days.length,25)
    assert.equal(day.days.reduce((sum,d)=>sum+BigInt(d.volume),0n),5000000000n)
    assert.deepEqual(day.payouts.map(p=>p.signature),['paid','team-paid'])
    assert.equal(all.platform.claimed,'1000000000');assert.equal(all.platform.buybackReserve,'600000000');assert.equal(all.platform.buybacks,0)
    assert.equal(all.platform.liquidityReserve,'200000000');assert.equal(all.platform.status,'MATCH')
    assert.doesNotMatch(JSON.stringify(all),/PRIVATE-SIGNED-DATA|created_by|wallet_source|signedTransaction/)
    await pool.query("insert into platform_revenue_allocations(allocation_group,claim_signature,github_repo_id,claimed_amount,buyback_amount,liquidity_amount,treasury_amount,policy_version,created_by) values('orphan','missing',998300,1000000000,600000000,200000000,200000000,1,'fixture')")
    const bad=await readProtocolAnalytics(pool,{now});assert.equal(bad.platform.status,'REVIEW');assert.equal(bad.platform.buybackReserve,undefined)
    assert.equal((await pool.query('select count(*)::int n from buyback_intents')).rows[0].n,0)
  } finally {await pool?.end();if(created)await admin.query('drop database repoing_analytics_test');await admin.end()}
})
