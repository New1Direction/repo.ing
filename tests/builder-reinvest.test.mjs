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
import {createClaim} from '../src/claim.mjs'
import {createReconciler} from '../src/reconcile.mjs'
import {createBuilderReinvest,createBuilderReinvestRecovery,reconcileBuilderReinvest,assertBuilderReinvestEnabled} from '../src/builder-reinvest.mjs'
import {canonicalReinvestPool,reinvestQuote,MAINNET_GENESIS} from '../src/builder-reinvest-chain.mjs'
import {verifyLiquidityReceipt} from '../src/liquidity-settlement.mjs'

const rpc=process.env.SOLANA_RPC_URL
assert.match(rpc??'',/^http:\/\/127\.0\.0\.1:\d+$/)
assert.equal(process.env.DATABASE_URL,'postgres://postgres:launchtest@127.0.0.1:55432/repoing_reinvest_test')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),connection=new Connection(rpc,'confirmed'),verification=new Connection(rpc,'finalized')
const env={BUILDER_REINVEST_ENABLED:'true',BUILDER_REINVEST_LOCAL_REHEARSAL:'true',NODE_ENV:'test'}
const repoId='997001',githubUserId='285551516'
const send=(tx,signers)=>sendAndConfirmTransaction(connection,tx,signers,{commitment:'finalized'})
const proxy=(original,overrides)=>new Proxy(original,{get(target,key){if(key in overrides)return overrides[key];const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
let permissions=true
const githubVerifier={verifyCurrentAuthority:async({githubRepoId})=>({verified:permissions,permission:permissions?'admin':'read',githubRepoId,githubUserId,verifiedAt:new Date()})}

test('mainnet activation cannot bypass the P3 proof with a local rehearsal flag',async()=>{
  await assert.rejects(assertBuilderReinvestEnabled({env:{},connection,verification}),/disabled/)
  const main=proxy(connection,{rpcEndpoint:'https://primary.invalid',getGenesisHash:async()=>MAINNET_GENESIS})
  const other=proxy(verification,{rpcEndpoint:'https://independent.invalid',getGenesisHash:async()=>MAINNET_GENESIS})
  await assert.rejects(assertBuilderReinvestEnabled({pool,connection:main,verification:other,env}),/P3 live MATCH/)
  await assert.rejects(assertBuilderReinvestEnabled({pool,connection,verification,env:{...env,NODE_ENV:'production'}}),/mainnet/)
})

test('claim first, cancel safely, then separately signed same-repo LP and replay-safe recovery', {timeout:600000},async t=>{
  t.after(()=>pool.end())
  await pool.query('truncate repositories restart identity cascade')
  const creator=Keypair.generate(),trader=Keypair.generate(),builder=Keypair.generate()
  for(const [key,sol] of [[creator,5],[trader,400],[builder,0.03]]){
    const sig=await connection.requestAirdrop(key.publicKey,Math.round(sol*1e9));await connection.confirmTransaction(sig,'finalized')
  }
  const {config}=await createFixedConfig(connection,'builders',{leftoverReceiver:creator.publicKey})
  const dbc=new DynamicBondingCurveClient(connection,'finalized')
  const market=await createLaunchCoordinator({pool,fetchImpl:async()=>({ok:true,status:200,json:async()=>({id:Number(repoId),name:'reinvest',full_name:'local/reinvest',owner:{login:'local'},private:false,archived:false,stargazers_count:1,forks_count:0,updated_at:'2026-01-01T00:00:00Z'})}),
    launcher:createMeteoraLauncher({connection,config,creator})}).launch({repositoryUrl:'https://github.com/local/reinvest',tokenName:'Reinvest',tokenSymbol:'RINV',launcherWallet:trader.publicKey.toBase58(),signTransaction:async tx=>{tx.partialSign(trader);return tx}})
  await connection.confirmTransaction(market.launchSignature,'finalized')
  await createLaunchIndexer({pool,verify:createLaunchEvidenceVerifier({connection,config})}).processMarket(BigInt(repoId))
  await pool.query('insert into repo_beneficiaries (github_repo_id,github_user_id,wallet) values($1,$2,$3)',[repoId,githubUserId,builder.publicKey.toBase58()])
  const fees=createExternalFeeIndexer({pool,connection,config}),claims=createClaim({pool,connection,config,creator,githubVerifier})
  const makeService=(changes={})=>createBuilderReinvest({pool,connection,verification,config,githubVerifier,env,...changes})
  const service=makeService(),base={repoId,wallet:builder.publicKey.toBase58(),githubUserId}
  async function reviewedClaim(){
    await fees.runOnce()
    const state=await createReconciler({pool,connection,config}).reconcile(repoId)
    assert.equal(state.status,'MATCH')
    const binding=(await pool.query('select * from repo_beneficiaries where github_repo_id=$1',[repoId])).rows[0]
    const before=await connection.getBalance(builder.publicKey,'finalized')
    const receipt=await claims.claim({githubRepoId:repoId,githubAuthorization:{session:true},review:{purpose:'creator-claim-review',repoId,wallet:base.wallet,
      boundAt:new Date(binding.bound_at).toISOString(),paid:String(state.recordedClaimed),amount:String(state.onchainCreatorFee),includeGraduatedFees:true,expiresAt:Date.now()+600000}})
    assert.equal(receipt.status,'settled');assert.equal(BigInt(await connection.getBalance(builder.publicKey,'finalized'))-BigInt(before),receipt.receiverDeltaLamports)
    return receipt
  }
  const poolKey=new PublicKey(market.pool)
  await send(await dbc.pool.swap2({owner:trader.publicKey,payer:trader.publicKey,pool:poolKey,amountIn:new BN(5e9),minimumAmountOut:new BN(1),swapBaseForQuote:false,swapMode:SwapMode.ExactIn,referralTokenAccount:null}),[trader])
  const first=await reviewedClaim()
  await assert.rejects(service.prepare({...base,claimSignature:first.signature,sourceAmount:'1000000',idempotencyKey:'before-graduation'}),/not graduated/)
  await send(await dbc.pool.swap2({owner:trader.publicKey,payer:trader.publicKey,pool:poolKey,amountIn:new BN(170e9),minimumAmountOut:new BN(1),swapBaseForQuote:false,swapMode:SwapMode.PartialFill,referralTokenAccount:null}),[trader])
  await send(new Transaction().add(SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:deriveDbcPoolAuthority(),lamports:1e9})),[trader])
  const migration=await dbc.migration.migrateToDammV2({pool:poolKey,dammConfig:DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],payer:trader.publicKey})
  await send(migration.transaction,[trader,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair])
  await fees.runOnce()
  const cancelStart=await connection.getBalance(builder.publicKey,'finalized')
  const firstArgs={...base,claimSignature:first.signature,sourceAmount:'1000000',idempotencyKey:'cancel-after-claim'}
  const offer=await service.prepare(firstArgs)
  assert.equal(offer.status,'prepared');assert.equal(Transaction.from(Buffer.from(offer.transaction,'base64')).verifySignatures(),false,'builder approval still missing')
  assert.equal((await service.cancel({...base,id:offer.id})).status,'cancelling')
  assert.equal(await connection.getBalance(builder.publicKey,'finalized'),cancelStart,'cancellation leaves claimed SOL in wallet')
  await assert.rejects(service.prepare({...firstArgs,idempotencyKey:'while-cancelling'}),/existing reinvestment/)

  const second=await reviewedClaim(),request={...base,claimSignature:second.signature,sourceAmount:'1000000',idempotencyKey:'reinvest-main-test'}
  await assert.rejects(service.prepare({...request,wallet:trader.publicKey.toBase58()}),/Wrong builder wallet/)
  await assert.rejects(service.prepare({...request,claimSignature:market.launchSignature}),/Claim must settle/)
  await assert.rejects(service.prepare({...request,pool:market.pool}),/canonical pool/)
  await assert.rejects(service.prepare({...request,mint:market.mint}),/canonical pool/)
  await assert.rejects(service.prepare({...request,sourceAmount:String(second.amountBaseUnits+1n)}),/exceeds/)
  await assert.rejects(service.prepare({...request,repoId:'997999'}),/indexed canonical/)
  permissions=false;await assert.rejects(service.prepare(request),/authority/);permissions=true
  const disagreement=proxy(verification,{getTransaction:async(...args)=>{const tx=await verification.getTransaction(...args);return tx?{...tx,slot:tx.slot+1}:tx}})
  await assert.rejects(makeService({verification:disagreement}).prepare(request),/RPC disagreement/)
  const snapshot=await canonicalReinvestPool(connection,verification,config,{...market,githubRepoId:repoId,creatorWallet:creator.publicKey.toBase58()})
  await assert.rejects(reinvestQuote(connection,snapshot,100000000000n),/price impact/)
  const intent=await service.prepare(request)
  await assert.rejects(service.prepare(request),/Duplicate/)
  assert.equal(intent.simulation.broadcast,false)
  const approve=offer=>{const tx=Transaction.from(Buffer.from(offer.transaction,'base64'));tx.partialSign(builder);return tx.serialize().toString('base64')}
  const submit={...base,id:intent.id,termsHash:intent.termsHash,signedTransaction:approve(intent)}
  const tampered=Transaction.from(Buffer.from(submit.signedTransaction,'base64'));tampered.add(SystemProgram.transfer({fromPubkey:builder.publicKey,toPubkey:trader.publicKey,lamports:1}));tampered.partialSign(builder)
  await assert.rejects(service.submit({...submit,signedTransaction:tampered.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')}),/signature or approved transaction/)
  await assert.rejects(service.submit({...submit,termsHash:'0'.repeat(64)}),/review changed/)
  const expiry=(await pool.query('select expires_at from builder_reinvest_intents where id=$1',[intent.id])).rows[0].expires_at
  await pool.query("update builder_reinvest_intents set expires_at=now()-interval '1 second' where id=$1",[intent.id])
  await assert.rejects(service.submit(submit),/expired/)
  await pool.query('update builder_reinvest_intents set expires_at=$2 where id=$1',[intent.id,expiry])
  await pool.query("update repo_beneficiaries set bound_at=bound_at+interval '1 second' where github_repo_id=$1",[repoId])
  await assert.rejects(service.submit(submit),/binding changed/)
  await pool.query("update repo_beneficiaries set bound_at=bound_at-interval '1 second' where github_repo_id=$1",[repoId])
  const claimsBefore=(await pool.query('select count(*)::int as n from repo_claims')).rows[0].n
  const results=await Promise.allSettled([service.submit(submit),service.submit(submit)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results.map(r=>r.reason?.message)))
  const settled=results.find(r=>r.status==='fulfilled').value
  assert.equal(settled.status,'settled');assert.equal(settled.settlement.lpOwner,base.wallet)
  assert.ok(BigInt(settled.settlement.economicDebit)<=1000000n)
  assert.equal((await pool.query('select count(*)::int as n from repo_claims')).rows[0].n,claimsBefore,'LP never performs another claim')
  await fees.runOnce()
  await assert.rejects(service.submit(submit),/Duplicate|replayed/)
  const durable=(await pool.query('select * from builder_reinvest_intents where id=$1',[intent.id])).rows[0]
  await assert.rejects(verifyLiquidityReceipt(connection,{...JSON.parse(durable.terms),id:durable.id,signature:durable.signature,signed_transaction:durable.signed_transaction,lp_owner:trader.publicKey.toBase58()}),/authority/)
  await assert.rejects(verifyLiquidityReceipt(connection,{...JSON.parse(durable.terms),id:durable.id,signature:durable.signature,signed_transaction:durable.signed_transaction,max_network_cost:'1'}),/exceeds/)
  await assert.rejects(verifyLiquidityReceipt(connection,{...JSON.parse(durable.terms),id:durable.id,signature:durable.signature,signed_transaction:durable.signed_transaction,token_a_mint:trader.publicKey.toBase58()}),/missing|deltas/i)
  await fees.runOnce()
  assert.equal((await createReconciler({pool,connection,config}).reconcile(repoId)).status,'MATCH')
  assert.equal((await reconcileBuilderReinvest({pool,connection,verification,repoId})).status,'MATCH')

  // Use only the still-unspent portion of the SAME settled claim. No fresh claim is sent.
  const next=await service.prepare({...request,idempotencyKey:'reinvest-lost-response'})
  const lost=proxy(connection,{sendRawTransaction:async(...args)=>{await connection.sendRawTransaction(...args);throw Error('Lost broadcast response')}})
  await assert.rejects(makeService({connection:lost}).submit({...base,id:next.id,termsHash:next.termsHash,signedTransaction:approve(next)}),/Lost broadcast/)
  const pending=(await pool.query('select * from builder_reinvest_intents where id=$1',[next.id])).rows[0]
  assert.equal(pending.status,'submitted')
  await assert.rejects(service.cancel({...base,id:next.id}),/cannot be cancelled/)
  await connection.confirmTransaction(pending.signature,'finalized')
  const uncertain=proxy(verification,{getTransaction:async()=>null})
  assert.ok((await createBuilderReinvestRecovery({pool,connection,env,verification:uncertain}).runOnce()).some(r=>r.id===next.id&&r.status==='review'))
  assert.equal((await pool.query('select status from builder_reinvest_intents where id=$1',[next.id])).rows[0].status,'submitted')
  const recovered=await createBuilderReinvestRecovery({pool,connection,verification,env}).runOnce()
  assert.ok(recovered.some(r=>r.id===next.id&&r.status==='settled'))
  await fees.runOnce()
  // A cancelled issued offer stays reserved: even an independent wallet broadcast is discovered once.
  const external=await service.prepare({...request,idempotencyKey:'wallet-broadcast-after-cancel'})
  await service.cancel({...base,id:external.id})
  const outsideSignature=await connection.sendRawTransaction(Buffer.from(approve(external),'base64'),{skipPreflight:false})
  await connection.confirmTransaction(outsideSignature,'finalized')
  assert.ok((await createBuilderReinvestRecovery({pool,connection,verification,env}).runOnce()).some(r=>r.id===external.id&&r.status==='settled'))
  await fees.runOnce()
  // Cancelled unsigned first offer must eventually release without altering the wallet.
  const end=Date.now()+130000
  while((await pool.query('select status from builder_reinvest_intents where id=$1',[offer.id])).rows[0].status!=='aborted'){
    assert.ok(Date.now()<end,'cancelled offer must expire safely')
    await createBuilderReinvestRecovery({pool,connection,verification,env}).runOnce()
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
  const paused=await makeService({env:{...env,BUILDER_REINVEST_ENABLED:'false'}}).status({...base,claimSignature:second.signature})
  assert.equal(paused.enabled,false);assert.ok(paused.intents.some(i=>i.status==='settled'),'receipts remain readable when execution is disabled')
  await assert.rejects(makeService({env:{...env,BUILDER_REINVEST_ENABLED:'false'}}).prepare({...request,idempotencyKey:'disabled-after-proof'}),/disabled/)
  const final=await reconcileBuilderReinvest({pool,connection,verification,repoId})
  assert.equal(final.open,0)
  assert.equal(final.status,'MATCH',JSON.stringify(final))
  assert.equal((await createReconciler({pool,connection,config}).reconcile(repoId)).status,'MATCH')
  assert.equal((await pool.query('select count(*)::int as n from repo_claims')).rows[0].n,claimsBefore)
  assert.equal((await pool.query('select count(*)::int as n from liquidity_intents')).rows[0].n,0,'builder LP does not use P3 custody or reserves')
  console.log(JSON.stringify({network:'localnet',repoId,claim:first.signature,secondClaim:second.signature,builder:base.wallet,pool:settled.terms.pool,lp:settled.position,signature:settled.signature,recoverySignature:pending.signature,reconciliation:final}))
})
