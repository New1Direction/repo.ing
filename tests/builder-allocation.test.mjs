import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { DynamicBondingCurveClient, SwapMode, deriveDbcPoolAuthority, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createBuilderAllocation, BUILDER_ALLOCATION, FIXED_SUPPLY } from '../src/builder-allocation.mjs'
import { createAllocationRecovery, settleAllocation } from '../src/builder-allocation-settlement.mjs'

test('fixed-supply builder grant: graduation, authority, exact settlement, replay and lost-response recovery', {timeout:240000}, async t => {
  assert.equal(process.env.SOLANA_RPC_URL,'http://127.0.0.1:8909')
  assert.equal(process.env.DATABASE_URL,'postgres://postgres@127.0.0.1:55443/repoing_graduation')
  const connection = new Connection(process.env.SOLANA_RPC_URL,'confirmed')
  const pool = new pg.Pool({connectionString:process.env.DATABASE_URL})
  t.after(()=>pool.end())
  await pool.query('truncate repositories restart identity cascade')
  const creator=Keypair.generate(), trader=Keypair.generate(), recipient=Keypair.generate()
  for (const [key,sol] of [[creator,5],[trader,500]]) {
    const signature=await connection.requestAirdrop(key.publicKey,sol*1e9)
    await connection.confirmTransaction({signature,...await connection.getLatestBlockhash()},'confirmed')
  }
  const {config}=await createFixedConfig(connection,'builders',{leftoverReceiver:creator.publicKey})
  process.env.BUILDER_ALLOCATION_CONFIGS=config.toBase58()
  t.after(()=>delete process.env.BUILDER_ALLOCATION_CONFIGS)
  const dbc = new DynamicBondingCurveClient(connection,'finalized')
  const send=(tx,signers)=>sendAndConfirmTransaction(connection,tx,signers,{commitment:'finalized',preflightCommitment:'confirmed'})
  let user='123'
  const githubVerifier={verifyCurrentAuthority:async({githubRepoId})=>({verified:true,permission:'admin',githubRepoId,githubUserId:BigInt(user),verifiedAt:new Date()})}
  const service=(rpc=connection)=>createBuilderAllocation({pool,connection:rpc,config,creator,githubVerifier})
  async function launch(repoId) {
    const fetchImpl=async()=>({ok:true,status:200,json:async()=>({id:Number(repoId),name:`allocation-${repoId}`,full_name:`local/allocation-${repoId}`,owner:{login:'local'},private:false,archived:false,stargazers_count:0,forks_count:0,updated_at:'2026-01-01T00:00:00Z'})})
    const market=await createLaunchCoordinator({pool,fetchImpl,discoveryEnabled:true,builderAllocationEnabled:true,launcher:createMeteoraLauncher({connection,config,creator})}).launch({repositoryUrl:`https://github.com/local/allocation-${repoId}`,tokenName:'Builder',tokenSymbol:'BUILD',launcherWallet:trader.publicKey.toBase58(),signTransaction:async tx=>{tx.partialSign(trader);return tx}})
    await connection.confirmTransaction(market.launchSignature,'finalized')
    assert.equal((await createLaunchIndexer({pool,verify:createLaunchEvidenceVerifier({connection,config})}).processMarket(BigInt(repoId))).state,'indexed')
    await pool.query('insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values($1,123,$2)',[repoId,recipient.publicKey.toBase58()])
    const {rows:[b]}=await pool.query('select * from repo_beneficiaries where github_repo_id=$1',[repoId])
    return {market,review:{repoId,githubUserId:'123',wallet:b.wallet,boundAt:b.bound_at.toISOString(),amount:String(BUILDER_ALLOCATION),expiresAt:Date.now()+600000}}
  }
  async function graduate(market) {
    const poolKey=new PublicKey(market.pool)
    await send(await dbc.pool.swap2({owner:trader.publicKey,payer:trader.publicKey,pool:poolKey,amountIn:new BN(170e9),minimumAmountOut:new BN(1),swapBaseForQuote:false,swapMode:SwapMode.PartialFill,referralTokenAccount:null}),[trader])
    await send(new Transaction().add(SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:deriveDbcPoolAuthority(),lamports:1e9})),[trader])
    const migration=await dbc.migration.migrateToDammV2({pool:poolKey,dammConfig:DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],payer:trader.publicKey})
    await send(migration.transaction,[trader,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair])
  }
  const a=await launch('990101')
  assert.equal(a.market.discoveryVersion,2)
  assert.equal((await service().status(a.review.repoId)).state,'locked')
  await assert.rejects(service().claim({review:a.review}),/locked/)
  await graduate(a.market)
  assert.equal((await service().status(a.review.repoId)).state,'available')
  await assert.rejects(service().claim({review:{...a.review,wallet:trader.publicKey.toBase58()}}),/wallet or authority changed/)
  await assert.rejects(service().claim({review:{...a.review,githubUserId:'999'}}),/admin authority/)
  user='999'
  await assert.rejects(service().claim({review:a.review}),/admin authority/)
  user='123'
  // Concurrent retries must still pay once.
  const outcomes=await Promise.allSettled([service().claim({review:a.review}),service().claim({review:a.review})])
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1)
  assert.equal(outcomes.find(o=>o.status==='fulfilled').value.status,'settled')
  assert.equal((await getAccount(connection,getAssociatedTokenAddressSync(new PublicKey(a.market.mint),recipient.publicKey),'finalized')).amount,BUILDER_ALLOCATION)
  assert.equal((await getMint(connection,new PublicKey(a.market.mint),'finalized')).supply,FIXED_SUPPLY)
  user='999'
  await pool.query('update repo_beneficiaries set github_user_id=999,wallet=$1,bound_at=now() where github_repo_id=$2',[trader.publicKey.toBase58(),a.review.repoId])
  await assert.rejects(service().claim({review:{...a.review,githubUserId:'999'}}),/already submitted or paid/)
  user='123'
  const b=await launch('990102'); await graduate(b.market)
  // Anyone may withdraw leftovers, but only to the protected receiver.
  await send(await dbc.migration.withdrawLeftover({pool:new PublicKey(b.market.pool),payer:trader.publicKey}),[trader])
  const lost=new Proxy(connection,{get(target,key){if(key==='sendRawTransaction')return async(...args)=>{await target.sendRawTransaction(...args);throw Error('Lost response')};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
  await assert.rejects(service(lost).claim({review:b.review}),/Lost response/)
  const {rows:[intent]}=await pool.query('select signature,signed_transaction as "signedTransaction",wallet,mint,amount::text from builder_allocation_claims where github_repo_id=$1',[b.review.repoId])
  await connection.confirmTransaction(intent.signature,'finalized')
  await assert.rejects(settleAllocation(pool,connection,{...intent,wallet:trader.publicKey.toBase58()}),/transfer|recipient/)
  const result=await createAllocationRecovery({pool,connection}).runOnce()
  assert.equal(result[0].status,'settled')
  assert.deepEqual(await createAllocationRecovery({pool,connection}).runOnce(),[])
  assert.equal((await getAccount(connection,getAssociatedTokenAddressSync(new PublicKey(b.market.mint),recipient.publicKey),'finalized')).amount,BUILDER_ALLOCATION)
  console.log(JSON.stringify({config:config.toBase58(),grantTokens:'10000000',fixedSupply:'1000000000',mint:a.market.mint,receipt:outcomes.find(o=>o.status==='fulfilled').value.signature,recoveryReceipt:intent.signature}))
})
