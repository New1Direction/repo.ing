import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, SwapMode as DbcSwapMode, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { SwapMode } from '@meteora-ag/cp-amm-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createGraduatedFees, migrationPosition } from '../src/graduated-fees.mjs'
import { createClaim } from '../src/claim.mjs'
import { createClaimRecovery } from '../src/claim-settlement.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { loadFinalizedTransaction } from '../src/finalized-transaction.mjs'

test('graduation credits finalized SOL fees, pays once, and recovers a lost broadcast', async () => {
  assert.equal(process.env.SOLANA_RPC_URL,'http://127.0.0.1:8909')
  assert.equal(process.env.DATABASE_URL,'postgres://postgres@127.0.0.1:55443/repoing_graduation')
  const connection = new Connection(process.env.SOLANA_RPC_URL,'confirmed')
  const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL })
  try {
    await pool.query('truncate repositories restart identity cascade')
    const { config } = await createFixedConfig(connection,'balanced')
    const creator=Keypair.generate(), trader=Keypair.generate(), receiver=Keypair.generate()
    for(const [signer,sol] of [[creator,5],[trader,200]]) {
      const signature=await connection.requestAirdrop(signer.publicKey,sol*1e9)
      await connection.confirmTransaction({signature,...await connection.getLatestBlockhash()},'confirmed')
    }
    const repoId='9900850'
    const fetchImpl=async()=>({ok:true,status:200,json:async()=>({id:Number(repoId),name:'graduation',full_name:'local/graduation',owner:{login:'local'},private:false,archived:false,stargazers_count:0,forks_count:0,updated_at:'2026-01-01T00:00:00Z'})})
    const launched=await createLaunchCoordinator({pool,fetchImpl,launcher:createMeteoraLauncher({connection,config,creator})}).launch({repositoryUrl:'https://github.com/local/graduation',tokenName:'Graduation',tokenSymbol:'GRAD',launcherWallet:trader.publicKey.toBase58(),signTransaction:async tx=>{tx.partialSign(trader);return tx}})
    const send=async(tx,signers)=>sendAndConfirmTransaction(connection,tx,signers,{commitment:'finalized',preflightCommitment:'confirmed'})
    const dbc=new DynamicBondingCurveClient(connection,'confirmed'), poolKey=new PublicKey(launched.pool)
    const finish=await dbc.pool.swap2({owner:trader.publicKey,payer:trader.publicKey,pool:poolKey,amountIn:new BN(170e9),minimumAmountOut:new BN(1),swapBaseForQuote:false,swapMode:DbcSwapMode.PartialFill,referralTokenAccount:null})
    await send(finish,[trader])
    const indexLaunch=await createLaunchIndexer({pool,verify:createLaunchEvidenceVerifier({connection,config})}).runOnce()
    assert.equal(indexLaunch[0].state,'indexed')
    const worker=()=>createExternalFeeIndexer({pool,connection,config})
    assert.equal((await worker().runOnce())[0].status,'OK')
    const before=await createReconciler({pool,connection,config}).reconcile(repoId)
    assert.equal(before.status,'MATCH')
    await send(new Transaction().add(SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:deriveDbcPoolAuthority(),lamports:1e9})),[trader])
    const migration=await dbc.migration.migrateToDammV2({pool:poolKey,dammConfig:DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],payer:trader.publicKey})
    const migrationSignature=await send(migration.transaction,[trader,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair])
    const market={...launched,githubRepoId:BigInt(repoId),creatorWallet:creator.publicKey.toBase58()}
    const fees=createGraduatedFees({connection,config})
    let snapshot=await fees.read(market)
    assert.equal(snapshot.available,0n)
    const proof=await loadFinalizedTransaction(connection,migrationSignature)
    assert.ok(migrationPosition(proof,market,config,snapshot.pool))
    assert.equal(migrationPosition(proof,{...market,mint:Keypair.generate().publicKey.toBase58()},config,snapshot.pool),null)
    const swap=async(buy)=>{
      const p=snapshot.poolState
      return send(await snapshot.amm.swap2({payer:trader.publicKey,pool:snapshot.pool,inputTokenMint:buy?NATIVE_MINT:p.tokenAMint,outputTokenMint:buy?p.tokenAMint:NATIVE_MINT,
        tokenAMint:p.tokenAMint,tokenBMint:p.tokenBMint,tokenAVault:p.tokenAVault,tokenBVault:p.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,
        referralTokenAccount:null,swapMode:SwapMode.ExactIn,amountIn:new BN(buy?100_000_000:1_000_000_000),minimumAmountOut:new BN(1)}),[trader])
    }
    await swap(true);await swap(false)
    snapshot=await fees.read(market)
    assert.ok(snapshot.available>0n)
    const indexed=(await worker().runOnce())[0]
    assert.equal(indexed.status,'OK',JSON.stringify(indexed,(_,v)=>typeof v==='bigint'?String(v):v))
    assert.equal(indexed.graduatedCredit,snapshot.earned)
    assert.equal((await worker().runOnce())[0].graduatedCredit,0n)
    let reconciliation=await createReconciler({pool,connection,config}).reconcile(repoId)
    assert.equal(reconciliation.status,'MATCH')
    assert.equal(reconciliation.onchainCreatorFee,before.onchainCreatorFee+snapshot.available)
    await pool.query('insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values($1,123,$2)',[repoId,receiver.publicKey.toBase58()])
    const {rows:[beneficiary]}=await pool.query('select * from repo_beneficiaries where github_repo_id=$1',[repoId])
    const verifier={verifyCurrentAuthority:async()=>({verified:true,permission:'admin',githubRepoId:BigInt(repoId),githubUserId:123n,verifiedAt:new Date()})}
    const request={githubRepoId:repoId,githubAuthorization:{},review:{repoId,wallet:beneficiary.wallet,boundAt:beneficiary.bound_at.toISOString(),paid:'0',amount:String(reconciliation.onchainCreatorFee),includeGraduatedFees:true,expiresAt:Date.now()+600000}}
    const claim=createClaim({pool,connection,config,creator,githubVerifier:verifier})
    await assert.rejects(claim.claim({...request,review:{...request.review,includeGraduatedFees:false}}),/updated claim review/)
    const unauthorized=createClaim({pool,connection,config,creator,githubVerifier:{verifyCurrentAuthority:async()=>({verified:false,permission:'write',githubRepoId:BigInt(repoId),githubUserId:123n,verifiedAt:new Date()})}})
    await assert.rejects(unauthorized.claim(request),/admin authority/)
    const receipt=await claim.claim(request)
    assert.equal(receipt.amountBaseUnits,reconciliation.onchainCreatorFee)
    assert.equal((await createReconciler({pool,connection,config}).reconcile(repoId)).status,'MATCH')
    await assert.rejects(claim.claim(request),/already used/)
    await swap(true)
    assert.equal((await worker().runOnce())[0].status,'OK')
    reconciliation=await createReconciler({pool,connection,config}).reconcile(repoId)
    const next={...request,review:{...request.review,paid:String(receipt.amountBaseUnits),amount:String(reconciliation.onchainCreatorFee)}}
    const broken=Object.create(connection)
    broken.simulateTransaction=async(...args)=>{
      const result=await connection.simulateTransaction(...args)
      await swap(true) // New fees arrive after review and preflight, before the authorized all-fees claim.
      return result
    }
    broken.sendRawTransaction=async bytes=>{await connection.sendRawTransaction(bytes);throw Error('Simulated connection loss after broadcast')}
    await assert.rejects(createClaim({pool,connection:broken,config,creator,githubVerifier:verifier}).claim(next),/Simulated connection loss/)
    assert.equal((await createReconciler({pool,connection,config}).reconcile(repoId)).status,'PENDING_REVIEW')
    let recovered
    for(let i=0;i<100;i++){
      recovered=await createClaimRecovery({pool,connection}).runOnce()
      if(recovered[0]?.status==='settled')break
      await new Promise(resolve=>setTimeout(resolve,300))
    }
    assert.equal(recovered[0]?.status,'settled',JSON.stringify(recovered))
    assert.deepEqual(await createClaimRecovery({pool,connection}).runOnce(),[])
    assert.equal((await worker().runOnce())[0].status,'OK')
    reconciliation=await createReconciler({pool,connection,config}).reconcile(repoId)
    assert.equal(reconciliation.status,'MATCH')
    assert.equal(reconciliation.expectedRemaining,0n)
    const {rows:[totals]}=await pool.query("select count(*)::int as count,sum(amount_base_units)::text as paid from repo_claims where status='settled'")
    assert.equal(totals.count,2)
    assert.ok(BigInt(totals.paid)>receipt.amountBaseUnits+BigInt(next.review.amount))
    assert.equal(BigInt(totals.paid),reconciliation.recordedEarned)
    // An unrecorded external position withdrawal is a discrepancy, never a fabricated payout.
    await pool.query('update repo_claims set damm_amount_base_units=damm_amount_base_units-1 where damm_amount_base_units>0')
    assert.equal((await createReconciler({pool,connection,config}).reconcile(repoId)).status,'MISMATCH')
    console.log(JSON.stringify({network:'local',config:config.toBase58(),migrationSignature,payout:receipt.signature,recovered:recovered[0].signature,earned:String(reconciliation.recordedEarned),paid:totals.paid,status:'MATCH'}))
  }finally{await pool.end()}
})
