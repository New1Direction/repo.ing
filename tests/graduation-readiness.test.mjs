import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import {Connection,Keypair,PublicKey,Transaction,SystemProgram,sendAndConfirmTransaction} from '@solana/web3.js'
import {NATIVE_MINT,TOKEN_PROGRAM_ID} from '@solana/spl-token'
import {DynamicBondingCurveClient,SwapMode,deriveDbcPoolAuthority,DAMM_V2_MIGRATION_FEE_ADDRESS,MigrationFeeOption} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {createFixedConfig} from './fixed-config.mjs'
import {createLaunchCoordinator} from '../src/launch-coordinator.mjs'
import {createMeteoraLauncher} from '../src/meteora-launch.mjs'
import {createLaunchEvidenceVerifier} from '../src/launch-evidence.mjs'
import {createLaunchIndexer} from '../src/launch-indexer.mjs'
import {createExternalFeeIndexer} from '../src/external-fee-indexer.mjs'
import {createGraduatedFees} from '../src/graduated-fees.mjs'
import {createPlatformFees} from '../src/platform-fees.mjs'
import {createPlatformRevenue} from '../src/platform-revenue.mjs'
import {createGraduationMonitor,graduationOperatorView,publicGraduation} from '../src/graduation-readiness.mjs'
import {readGraduationState} from '../src/graduation-state.mjs'
import {readFileSync} from 'node:fs'

assert.equal(process.env.DATABASE_URL,'postgres://postgres:launchtest@127.0.0.1:55432/repoing_p5_test')
assert.equal(process.env.SOLANA_RPC_URL,'http://127.0.0.1:8909')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL})
const connection=new Connection(process.env.SOLANA_RPC_URL,'confirmed'),verification=new Connection(process.env.SOLANA_RPC_URL,'finalized')
const env={...JSON.parse(readFileSync('docs/P3_FIRST_LIVE_SETTINGS.json')),BUILDER_REINVEST_ENABLED:'false',NODE_ENV:'test'}
// Large enough that the DAMM platform claim clears the dust floor (20x its priority-fee network cost).
const DAMM_TRADE_LAMPORTS='5000000000'
const proxy=(original,overrides)=>new Proxy(original,{get(target,key){if(key in overrides)return overrides[key];const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})

test('P5 detects one real local graduation, indexes actual DAMM trades, alerts and reaches review eligibility without spending',{timeout:600000},async t=>{
  t.after(()=>pool.end());await pool.query('truncate repositories restart identity cascade')
  await pool.query('truncate platform_revenue_policies,platform_revenue_allocations,buyback_intents restart identity cascade')
  const creator=Keypair.generate(),trader=Keypair.generate(),repoId='998001'
  for(const [key,sol] of [[creator,5],[trader,220]]){const sig=await connection.requestAirdrop(key.publicKey,sol*1e9);await connection.confirmTransaction(sig,'finalized')}
  const {config,partner}=await createFixedConfig(connection,'builders',{leftoverReceiver:creator.publicKey})
  const dbc=new DynamicBondingCurveClient(connection,'finalized'),send=(tx,keys)=>sendAndConfirmTransaction(connection,tx,keys,{commitment:'finalized'})
  const launched=await createLaunchCoordinator({pool,fetchImpl:async()=>({ok:true,status:200,json:async()=>({id:Number(repoId),name:'graduation',full_name:'local/graduation',owner:{login:'local'},private:false,archived:false,stargazers_count:1,forks_count:0,updated_at:'2026-01-01T00:00:00Z'})}),launcher:createMeteoraLauncher({connection,config,creator})}).launch({repositoryUrl:'https://github.com/local/graduation',tokenName:'Graduation',tokenSymbol:'GRAD',launcherWallet:trader.publicKey.toBase58(),signTransaction:async tx=>{tx.partialSign(trader);return tx}})
  await connection.confirmTransaction(launched.launchSignature,'finalized')
  await createLaunchIndexer({pool,verify:createLaunchEvidenceVerifier({connection,config})}).runOnce()
  const market={...launched,githubRepoId:repoId,creatorWallet:creator.publicKey.toBase58()},fees=createExternalFeeIndexer({pool,connection,config})
  const monitor=(changes={})=>createGraduationMonitor({pool,connection,verification,config,env,...changes})
  async function cycle(){assert.equal((await fees.runOnce())[0].status,'OK');const result=await monitor().runOnce();assert.equal(result[0].status,'VERIFIED',JSON.stringify(result));return result}
  await cycle()
  let state=await readGraduationState({connection,verification,config,market,env})
  assert.equal(state.phase,'CURVE');assert.equal(state.thresholdLamports,'85000000000')
  assert.equal((await pool.query('select count(*)::int as n from graduation_events')).rows[0].n,0)
  const buy=async amount=>send(await dbc.pool.swap2({owner:trader.publicKey,payer:trader.publicKey,pool:new PublicKey(market.pool),amountIn:new BN(amount),minimumAmountOut:new BN(1),swapBaseForQuote:false,swapMode:SwapMode.PartialFill,referralTokenAccount:null}),[trader])
  await buy('70000000000');await cycle();await cycle()
  assert.equal((await pool.query("select count(*)::int as n from graduation_alerts where kind='PROGRESS_75'")).rows[0].n,1)
  await buy('10000000000');await cycle()
  assert.equal((await pool.query("select count(*)::int as n from graduation_alerts where kind='PROGRESS_90'")).rows[0].n,1)
  await buy('10000000000');await cycle()
  state=await readGraduationState({connection,verification,config,market,env})
  assert.equal(state.phase,'CURVE');assert.equal(state.status,'migrating');assert.equal(state.progressPercent,100)
  assert.equal((await pool.query('select count(*)::int as n from graduation_events')).rows[0].n,0)
  await send(new Transaction().add(SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:deriveDbcPoolAuthority(),lamports:1e9})),[trader])
  const migration=await dbc.migration.migrateToDammV2({pool:new PublicKey(market.pool),dammConfig:DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],payer:trader.publicKey})
  const signature=await send(migration.transaction,[trader,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair])
  await cycle();await cycle()
  const {rows:[event]}=await pool.query('select * from graduation_events')
  assert.equal(event.signature,signature);assert.ok(event.previous_observation);assert.equal(JSON.parse(event.reconciliation).status,'MATCH')
  const proof=JSON.parse(event.evidence);assert.ok(proof.migration.pre.tokens);assert.ok(proof.migration.post.tokens);assert.ok(proof.migration.creatorPosition);assert.ok(proof.migration.partnerPosition)
  let view=await graduationOperatorView(pool,env)
  assert.equal(view.markets[0].phase,'GRADUATED');assert.equal(view.markets[0].p3.eligible,false)
  const snapshot=await createGraduatedFees({connection,config}).read(market),p=snapshot.poolState
  const trade=await send(await snapshot.amm.swap2({payer:trader.publicKey,pool:snapshot.pool,inputTokenMint:NATIVE_MINT,outputTokenMint:p.tokenAMint,tokenAMint:p.tokenAMint,tokenBMint:p.tokenBMint,tokenAVault:p.tokenAVault,tokenBVault:p.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,referralTokenAccount:null,swapMode:SwapMode.ExactIn,amountIn:new BN(DAMM_TRADE_LAMPORTS),minimumAmountOut:new BN(1)}),[trader])
  await cycle();await cycle()
  const {rows:trades}=await pool.query('select * from damm_trade_events')
  assert.equal(trades.length,1);assert.equal(trades[0].signature,trade);assert.equal(trades[0].quote_amount,DAMM_TRADE_LAMPORTS)
  const platform=createPlatformFees({pool,connection,config,partner}),status=await platform.status(repoId)
  assert.ok(BigInt(status.available)>0n)
  const claim=await platform.claim({review:{purpose:'platform-fee-review',repoId,amount:status.available,receiver:partner.publicKey.toBase58(),expiresAt:Date.now()+60000}})
  assert.equal(claim.status,'settled')
  const revenue=createPlatformRevenue({pool,partnerWallet:partner.publicKey})
  await revenue.createPolicy({buybackPermille:600,liquidityPermille:200,createdBy:'test'})
  await revenue.activatePolicy({version:1,createdBy:'test'})
  await revenue.allocate({review:{purpose:'platform-revenue-allocate',policyVersion:1,expiresAt:Date.now()+60000},createdBy:'test'})
  await cycle();view=await graduationOperatorView(pool,env)
  assert.equal(view.markets[0].p3.eligible,true,JSON.stringify(view.markets[0].p3));assert.ok(BigInt(view.reserve.remaining)>0n)
  assert.deepEqual(view.execution,{p3:false,p4:false});assert.deepEqual(view.reconciliation,{revenue:'MATCH',liquidity:'MATCH'})
  const kinds=(await pool.query('select kind from graduation_alerts')).rows.map(r=>r.kind)
  for(const k of ['PROGRESS_75','PROGRESS_90','GRADUATED','PARTNER_FEES_FIRST_ACCRUED','PLATFORM_CLAIM_AVAILABLE','P3_FIRST_ELIGIBLE'])assert.equal(kinds.filter(x=>x===k).length,1,k)
  const conflict=proxy(verification,{getMultipleAccountsInfoAndContext:async(...args)=>{const r=await verification.getMultipleAccountsInfoAndContext(...args);return {...r,value:r.value.map((a,i)=>i===0?{...a,data:Buffer.concat([a.data,Buffer.from([1])])}:a)}}})
  assert.equal((await monitor({verification:conflict}).runOnce())[0].status,'REVIEW')
  const row=(await pool.query('select * from graduation_observations')).rows[0]
  assert.throws(()=>publicGraduation(row),/RPC_DISAGREEMENT/)
  const missing=proxy(verification,{getMultipleAccountsInfoAndContext:async(...args)=>{const r=await verification.getMultipleAccountsInfoAndContext(...args);return args[0].length===5?{...r,value:r.value.map((a,i)=>i===3?null:a)}:r}})
  assert.equal((await monitor({verification:missing}).runOnce())[0].status,'REVIEW')
  await assert.rejects(readGraduationState({connection,verification,config,market:{...market,mint:trader.publicKey.toBase58()},env}),/approved DBC config/)
  await cycle()
  await pool.query('insert into platform_fee_events(github_repo_id,pool,position,slot,amount_base_units,cumulative_earned,cumulative_claimed,evidence_hash,evidence) values($1,$2,$3,1,1,999999999,0,$4,$5)',[repoId,snapshot.pool.toBase58(),snapshot.partner.position.toBase58(),'x'.repeat(64),'{}'])
  const mismatch=await monitor().runOnce()
  assert.equal(mismatch[0].reconciliation,'MISMATCH');assert.ok(mismatch[0].alerts.some(a=>a.kind==='RECONCILIATION_MISMATCH'))
  // Same shape the public curve route reads: the durable migration proof hash comes from graduation_events.
  const mismatchedRow=(await pool.query(`select o.*,e.evidence_hash as migration_evidence_hash from graduation_observations o
    left join graduation_events e on e.github_repo_id=o.github_repo_id`)).rows[0]
  // The operator alert above still fires; public progress stays visible for proven graduation.
  assert.equal(publicGraduation(mismatchedRow).phase,'GRADUATED')
  await pool.query('delete from platform_fee_events where evidence_hash=$1',['x'.repeat(64)])
  await cycle()
  assert.equal((await pool.query('select count(*)::int as n from graduation_events')).rows[0].n,1)
  assert.equal((await pool.query('select count(*)::int as n from liquidity_intents')).rows[0].n,0)
  assert.equal((await pool.query('select count(*)::int as n from builder_reinvest_intents')).rows[0].n,0)
  console.log(JSON.stringify({network:'localnet',repoId,migration:signature,dammPool:snapshot.pool.toBase58(),creatorPosition:snapshot.position.toBase58(),partnerPosition:snapshot.partner.position.toBase58(),trade,claim:claim.signature,reserve:(await graduationOperatorView(pool,env)).reserve,spending:false,reconciliation:'MATCH'}))
})
