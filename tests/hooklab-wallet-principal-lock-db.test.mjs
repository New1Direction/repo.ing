import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID,createHash } from 'node:crypto'
import pg from 'pg'
import { lockWalletPrincipal } from '../src/hooklab-wallet-principal-lock.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const token=Buffer.alloc(32,4).toString('base64url'),digest=createHash('sha256').update(token).digest('hex'),wallet='11111111111111111111111111111111'
test('same-transaction session lock serializes revocation and rechecks expiry after waits',async()=>{
 const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'},admin=new pg.Pool(config),database=`wallet_lock_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
  await pool.query(await readFile(new URL('../src/hooklab-wallet-principal-schema.sql',import.meta.url),'utf8'))
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",[digest,wallet,HOOK_MAINNET_GENESIS])
  const db=await pool.connect()
  try{
   await db.query('begin');const principal=await lockWalletPrincipal(db,token,'https://repo.ing');assert.equal(principal.wallet,wallet);assert.equal(principal.canLaunch,false)
   let revoked=false;const revoke=pool.query('update hook_lab_wallet_sessions set revoked_at=clock_timestamp() where token_sha256=$1',[digest]).then(()=>{revoked=true})
   await new Promise(r=>setTimeout(r,50));assert.equal(revoked,false)
   await db.query('commit');await revoke;assert.equal(revoked,true)
   await db.query('begin');await assert.rejects(lockWalletPrincipal(db,token,'https://repo.ing'));await db.query('rollback')
   await pool.query("update hook_lab_wallet_sessions set revoked_at=null,expires_at=clock_timestamp()+interval '30 minutes' where token_sha256=$1",[digest])
   await db.query('begin');await assert.rejects(lockWalletPrincipal(db,token,'https://evil.invalid'));await db.query('rollback')
   await db.query('begin');await db.query('select * from hook_lab_wallet_sessions where token_sha256=$1 for update',[digest])
   const waiter=await pool.connect()
   try{
    await waiter.query('begin');const pending=lockWalletPrincipal(waiter,token,'https://repo.ing'),rejected=assert.rejects(pending)
    await db.query("update hook_lab_wallet_sessions set expires_at=clock_timestamp()-interval '1 second' where token_sha256=$1",[digest]);await db.query('commit');await rejected;await waiter.query('rollback')
   }finally{waiter.release()}
  }finally{await db.query('rollback');db.release()}
 }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
