import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID,createHash } from 'node:crypto'
import pg from 'pg'
import { coLocatedWalletPreparationJournal,walletPreparationJournal } from '../src/hooklab-wallet-preparation.mjs'
import { maxWalletPreparationReceiptFixture,maxWalletPreparationRpcProviders } from './fixtures/hooklab-max-wallet-preparation-receipts.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const token=Buffer.alloc(32,37).toString('base64url'),digest=createHash('sha256').update(token).digest('hex')
test('durable launch resolution requires actual co-located auth and fresh conflict-free exact preparation',async()=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`launch_resolver_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  for(const file of ['hooklab-wallet-principal-schema.sql','hooklab-wallet-preparation-schema.sql'])await pool.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'))
  const f=maxWalletPreparationReceiptFixture({samePayer:true,seedLabel:'launch-resolver'}),rpc=maxWalletPreparationRpcProviders(f),owner=f.preparationInput.request.creator
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,owner,JSON.parse(f.preparationInput.profile.json).genesisHash])
  const settings={enabled:true,origin:'https://repo.ing',providers:rpc.providers,expectedProfileSha256:f.expectedProfileSha256},journal=coLocatedWalletPreparationJournal(pool,settings),id=randomUUID()
  await journal.collectAndRetain(token,id,{preparationInput:f.preparationInput,signedTransactionBase64:f.signedTransactionBase64})
  const resolved=await journal.resolveForLaunch(token,id)
  assert.equal(resolved.id,id);assert.equal(resolved.wallet,owner);assert.deepEqual(resolved.preparedRequest,f.preparationInput.request)
  assert.equal(resolved.executionSlot,f.observations[0].transaction.slot)
  assert.deepEqual(Object.keys(resolved.preparedAccountHashes).sort(),['policy','registry','selectedConfig'])
  await assert.rejects(walletPreparationJournal(pool,{enabled:true,principalStore:{resolve:async()=>({wallet:owner})},providers:rpc.providers,expectedProfileSha256:f.expectedProfileSha256}).resolveForLaunch(token,id))
  await pool.query('update hook_lab_wallet_sessions set revoked_at=clock_timestamp() where token_sha256=$1',[digest]);await assert.rejects(journal.resolveForLaunch(token,id))
  await pool.query('update hook_lab_wallet_sessions set revoked_at=null where token_sha256=$1',[digest])
  const original=rpc.providers[1].connection.getBlockSignatures
  rpc.providers[1].connection.getBlockSignatures=async(...args)=>({...await original(...args),blockhash:f.preparationInput.request.mint})
  await assert.rejects(journal.resolveForLaunch(token,id))
  rpc.providers[1].connection.getBlockSignatures=original
  await assert.rejects(journal.resolveForLaunch(token,id));assert.equal((await journal.get(token,id)).evidenceConflict,true)
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
