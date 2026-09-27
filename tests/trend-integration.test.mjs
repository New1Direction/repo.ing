import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createTrendIntake,trendCandidate,reviewTrend,trendLaunchGuard,syncTrendLaunches,trendOperatorView } from '../src/trend-intake.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { discovererLeaderboard } from '../src/discoverer-growth.mjs'

test('P6 isolated database: intake, review, guarded explicit launch, recovery, immutable attribution, leaderboard',async()=>{
  const url='postgres://postgres:launchtest@127.0.0.1:55432/repoing_p6_test'
  assert.equal(process.env.DATABASE_URL,url)
  const admin=new pg.Pool({connectionString:url.replace('/repoing_p6_test','/postgres')});let pool,created=false
  try{
    await admin.query('create database repoing_p6_test');created=true;pool=new pg.Pool({connectionString:url})
    await migrate(drizzle(pool),{migrationsFolder:'drizzle'});await migrate(drizzle(pool),{migrationsFolder:'drizzle'})
    let time=Date.now(),seedCalls=0,observations=0
    const config=Keypair.generate().publicKey,wallet=Keypair.generate().publicKey.toBase58(),creator=Keypair.generate().publicKey.toBase58()
    const makeObservation=()=>({repo:{id:'998100',fullName:'local/trend',description:'Local fixture'},observedAt:new Date(time).toISOString(),stars:100+observations*10,forks:10,releaseAt:null,activity:{complete:false},sources:{identity:'https://api.github.com/repos/local/trend',commits:'https://api.github.com/repos/local/trend/commits'}})
    const sources={seeds:async()=>{seedCalls++;return {health:[{source:'github_trending',status:'OK',count:1}],signals:[{repository:'https://github.com/local/trend',source:'github_trending',url:'https://github.com/trending',note:'fixture',occurredAt:new Date(time).toISOString(),expiresAt:new Date(time+3600000).toISOString()}]}},observe:async()=>{observations++;return makeObservation()}}
    const intake=createTrendIntake({pool,sources,now:()=>time})
    await intake.runOnce();assert.equal((await intake.runOnce()).status,'WAITING');assert.equal(seedCalls,1)
    let candidate=await trendCandidate(pool,'998100');assert.equal(candidate.state,'detected');assert.equal(candidate.score.warmingUp,true)
    const resolve=async()=>({githubRepoId:998100n,fullName:'local/trend'})
    const review=(to,revision,overrides={})=>reviewTrend({pool,repoId:'998100',to,revision,operator:'42',config:config.toBase58(),discoveryEnabled:true,resolve,...overrides})
    await assert.rejects(()=>review('approved',0),/TRANSITION/)
    await review('reviewed',0)
    await assert.rejects(()=>review('approved',0),/CHANGED/)
    await assert.rejects(()=>review('approved',1,{resolve:async()=>({githubRepoId:998101n})}),/DISAGREEMENT/)
    await assert.rejects(()=>review('approved',1,{discoveryEnabled:false}),/ENROLLMENT/)
    await review('approved',1)
    candidate=await trendCandidate(pool,'998100');assert.equal(candidate.ready,true)
    const guard=trendLaunchGuard({pool,repoId:'998100',revision:2,config:config.toBase58(),discoveryEnabled:true})
    const guardMint=Keypair.generate().publicKey,guardMarket={mint:guardMint.toBase58(),pool:deriveDbcPoolAddress(NATIVE_MINT,guardMint,config).toBase58(),launcherWallet:wallet,discoveryVersion:2}
    const guardInput={repo:{githubRepoId:998100n,fullName:'local/trend'},market:guardMarket,stage:'submit'}
    await assert.rejects(()=>guard({...guardInput,repo:{githubRepoId:998101n,fullName:'local/other'}}),/DISAGREEMENT/)
    await assert.rejects(()=>guard({...guardInput,market:{...guardMarket,discoveryVersion:1}}),/PERIOD/)
    await assert.rejects(()=>guard({...guardInput,market:{...guardMarket,launcherWallet:null}}),/ATTRIBUTION/)
    await pool.query("update trend_candidates set observed_at=now()-interval '7 hours' where github_repo_id=998100")
    await assert.rejects(()=>guard(guardInput),/STALE/)
    await pool.query('update trend_candidates set observed_at=now() where github_repo_id=998100')
    let broadcast=0,signCalls=0
    const launcher={creatorWallet:creator,prepare:async()=>{const mint=Keypair.generate().publicKey;return {mint:mint.toBase58(),pool:deriveDbcPoolAddress(NATIVE_MINT,mint,config).toBase58(),blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100n,
      sign:async callback=>{signCalls++;await callback({});return {raw:Buffer.from('fixture'),signature:Keypair.generate().publicKey.toBase58()}}}},submit:async()=>{broadcast++},inspect:async()=>true}
    const fetchImpl=async()=>({ok:true,json:async()=>({id:998100,full_name:'local/trend',name:'trend',owner:{login:'local'},private:false,archived:false,stargazers_count:100,forks_count:10,updated_at:new Date(time).toISOString()})})
    const coordinator=createLaunchCoordinator({pool,launcher,fetchImpl,discoveryEnabled:true})
    const request={repositoryUrl:'https://github.com/local/trend',tokenName:'Trend',tokenSymbol:'TREND',launcherWallet:wallet,signTransaction:async tx=>tx}
    await assert.rejects(()=>coordinator.launch({...request,launchGuard:trendLaunchGuard({pool,repoId:'998100',revision:2,config:Keypair.generate().publicKey.toBase58(),discoveryEnabled:true})}),/CONFIG_MISMATCH/)
    assert.equal(signCalls,0);assert.equal(broadcast,0)
    await assert.rejects(()=>coordinator.launch({...request,launchGuard:guard,signTransaction:async()=>{await review('reviewed',2);return {}}}),/APPROVAL/)
    assert.equal(broadcast,0)
    await review('approved',3)
    const validGuard=trendLaunchGuard({pool,repoId:'998100',revision:4,config:config.toBase58(),discoveryEnabled:true})
    const market=await coordinator.launch({...request,launchGuard:validGuard});assert.equal(broadcast,1)
    await pool.query("update markets set indexed_at=now(),last_verified_at=now(),launch_finality='finalized',launch_slot=100,launch_block_time=date_trunc('second',now()) where github_repo_id=998100")
    const tradeTime=(await pool.query('select launch_block_time from markets where github_repo_id=998100')).rows[0].launch_block_time
    await pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price) values($1,'fixture-trade',0,101,$2,'buy','10000','100','1')`,[market.pool,tradeTime])
    const db=await pool.connect();try{await syncTrendLaunches(db);await syncTrendLaunches(db)}finally{db.release()}
    assert.equal((await trendCandidate(pool,'998100')).state,'active')
    assert.equal((await pool.query("select count(*)::int n from trend_reviews where to_state='launched'")).rows[0].n,1)
    await assert.rejects(()=>pool.query('update markets set launcher_wallet=$1 where github_repo_id=998100',[creator]),/immutable/)
    await assert.rejects(()=>pool.query('update markets set discovery_version=1 where github_repo_id=998100'),/immutable/)
    await pool.query(`insert into discovery_fee_events(github_repo_id,pool,signature,event_index,partner_amount,slot,traded_at) values(998100,$1,'fixture-trade',0,100,101,$2)`,[market.pool,tradeTime])
    const client=await pool.connect();try{await syncTrendLaunches(client)}finally{client.release()}
    const result=await discovererLeaderboard(pool,config.toBase58(),'')
    assert.equal(result.excluded.length,0);assert.equal(result.leaders[0].earned,'50');assert.equal(result.leaders[0].volume,'10000');assert.equal(result.leaders[0].launched,1)
    assert.equal((await trendCandidate(pool,'998100')).state,'active')
    assert.equal((await trendOperatorView(pool)).candidates.length,1)
    assert.equal(await coordinator.launch(request).then(m=>m.mint),market.mint);assert.equal(broadcast,1)
    assert.equal((await pool.query('select count(*)::int n from liquidity_intents')).rows[0].n,0)
    assert.equal((await pool.query('select count(*)::int n from builder_reinvest_intents')).rows[0].n,0)
  }finally{await pool?.end();if(created)await admin.query('drop database repoing_p6_test');await admin.end()}
})
