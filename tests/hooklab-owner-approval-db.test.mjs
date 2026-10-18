// Synthetic keys and a disposable database only. No RPC, no real admin key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash,randomUUID,sign as edSign,createPrivateKey } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { ownerApprovalStore,remoteAdminSigner,verifyEd25519 } from '../src/hooklab-owner-approval.mjs'

const seed=label=>createHash('sha256').update(`OWNER APPROVAL TEST FIXTURE ONLY: ${label}`).digest()
const keypair=label=>Keypair.fromSeed(seed(label))
const signWith=(label,message)=>edSign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed(label)]),format:'der',type:'pkcs8'}))
const admin=keypair('admin').publicKey.toBase58(),creatorA=keypair('creator-a').publicKey.toBase58(),creatorB=keypair('creator-b').publicKey.toBase58()
const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'}

async function withDatabase(work){
 const root=new pg.Pool(config),name=`owner_approval_${randomUUID().replaceAll('-','')}`;let pool
 try{
  await root.query(`create database ${name}`);pool=new pg.Pool({...config,database:name})
  await pool.query(await readFile(new URL('../src/hooklab-owner-approval-schema.sql',import.meta.url),'utf8'))
  await work(pool)
 }finally{await pool?.end();await root.query(`drop database if exists ${name} with (force)`);await root.end()}
}
function reviewFor(message,{validUntilSlot=1_000,lastValidBlockHeight=2_000,reviewExpiresAtMs=Date.now()+60_000}={}){
 const bytes=Buffer.from(message)
 return {operation:'max-wallet-launch',messageBase64:bytes.toString('base64'),messageSha256:createHash('sha256').update(bytes).digest('hex'),
  requiredSigners:[creatorA,admin],validUntilSlot,lastValidBlockHeight,reviewExpiresAtMs}
}
const intent={name:'Canary Coin',symbol:'CNRY',uri:''}

test('presence, queue, single invite and exact-detail binding',async()=>withDatabase(async pool=>{
 const store=ownerApprovalStore(pool,{adminAddress:admin})
 assert.equal((await store.availability()).online,false)
 await assert.rejects(store.heartbeat({accepting:true,agentAddress:creatorA}),/configured admin/)
 await store.heartbeat({accepting:true,agentAddress:admin})
 assert.equal((await store.availability()).online,true)
 await pool.query("update hook_lab_owner_presence set last_seen_at=clock_timestamp()-interval '1 minute'")
 assert.equal((await store.availability()).online,false,'stale heartbeat reads as offline')
 await store.heartbeat({accepting:false,agentAddress:admin})
 assert.equal((await store.availability()).online,false,'paused agent reads as offline')

 const a=await store.createRequest(creatorA,{id:randomUUID(),...intent})
 await assert.rejects(store.createRequest(creatorA,{id:randomUUID(),...intent}),/already have an open/)
 const b=await store.createRequest(creatorB,{id:randomUUID(),...intent,symbol:'BBB'})
 await assert.rejects(store.invite(a.id,{inviteMs:30_000}),/1-60 minutes/)
 assert.equal((await store.invite(a.id,{inviteMs:600_000})).status,'invited')
 await assert.rejects(store.invite(b.id,{inviteMs:600_000}),/Another creator is already invited/)

 const op=randomUUID(),db=await pool.connect()
 try{
  await assert.rejects(store.bindLaunch(db,creatorB,op,{...intent,symbol:'BBB'}),/Wait for repo.ing/)
  await assert.rejects(store.bindLaunch(db,creatorA,op,{...intent,name:'Other'}),/differ from the approved/)
  assert.equal((await store.bindLaunch(db,creatorA,op,intent)).status,'launching')
  assert.equal((await store.bindLaunch(db,creatorA,op,intent)).custodyOperationId,op,'same operation is idempotent')
  await assert.rejects(store.bindLaunch(db,creatorA,randomUUID(),intent),/bound to another launch/)
 }finally{db.release()}
 await assert.rejects(store.invite(b.id,{inviteMs:600_000}),/Another creator is already invited/,'launching still blocks a second creator')
 assert.equal((await store.markLaunched(op)).status,'launched')
 assert.equal((await store.invite(b.id,{inviteMs:600_000})).status,'invited','next creator after the launch lands')
 await pool.query("update hook_lab_launch_requests set invite_expires_at=clock_timestamp()-interval '1 second' where id=$1",[b.id])
 assert.equal((await store.requestFor(creatorB)).status,'invite-expired')
 const again=await store.createRequest(creatorB,{id:randomUUID(),...intent})
 assert.equal((await store.decline(again.id)).status,'declined')
}))

test('remote admin signer returns only a verified owner signature before the real deadline',async()=>withDatabase(async pool=>{
 const store=ownerApprovalStore(pool,{adminAddress:admin}),message=Buffer.from('synthetic launch message 1')
 let slot=900,signedOnce=0
 const observe=async()=>({slot,blockHeight:1_900,nowMs:Date.now()})
 const sleep=async()=>{
  const {rows:[pending]}=await pool.query("select id from hook_lab_owner_sign_requests where status='pending'")
  if(pending&&!signedOnce++){
   await assert.rejects(store.submitSignature(pending.id,signWith('creator-a',message).toString('base64')),/does not verify/,'wrong key rejected')
   await store.submitSignature(pending.id,signWith('admin',message).toString('base64'))
  }
 }
 const signer=remoteAdminSigner(pool,{address:admin,observe,sleep})
 await assert.rejects(signer.sign(message,{review:reviewFor('different bytes')}),/differs from its review/)
 const signature=await signer.sign(message,{review:reviewFor(message),owner:creatorA})
 assert.ok(verifyEd25519(admin,message,signature))
 const repeat=await signer.sign(message,{review:reviewFor(message)})
 assert.deepEqual(Buffer.from(repeat),Buffer.from(signature),'same message never produces a second request')
 assert.equal((await pool.query('select count(*)::int as n from hook_lab_owner_sign_requests')).rows[0].n,1)

 // Deadline is the earliest of slot, block height and review expiry, minus margins.
 for(const [label,limits,observed] of [
  ['deadline slot',{validUntilSlot:1_000},{slot:990,blockHeight:1_000}],
  ['blockhash height',{lastValidBlockHeight:2_000},{slot:100,blockHeight:1_990}],
  ['review expiry',{reviewExpiresAtMs:Date.now()+2_000},{slot:100,blockHeight:1_000}],
 ]){
  const m=Buffer.from(`expiring message: ${label}`)
  const late=remoteAdminSigner(pool,{address:admin,observe:async()=>({...observed,nowMs:Date.now()}),sleep:async()=>{}})
  await assert.rejects(late.sign(m,{review:reviewFor(m,limits)}),/window closed/,label)
  const {rows:[row]}=await pool.query('select id,status from hook_lab_owner_sign_requests where message_sha256=$1',[reviewFor(m).messageSha256])
  assert.equal(row.status,'expired',label)
  await assert.rejects(store.submitSignature(row.id,signWith('admin',m).toString('base64')),/no longer pending/,`${label}: late signature refused`)
  await assert.rejects(late.sign(m,{review:reviewFor(m,limits)}),/expired/,`${label}: expired message is never re-requested`)
 }

 // Owner declines.
 const declined=Buffer.from('declined message')
 const signerDecline=remoteAdminSigner(pool,{address:admin,observe,sleep:async()=>{
  const {rows:[p]}=await pool.query("select id from hook_lab_owner_sign_requests where status='pending'");if(p)await store.declineSignRequest(p.id)}})
 await assert.rejects(signerDecline.sign(declined,{review:reviewFor(declined)}),/declined/)

 // Race: the owner's signature lands in the same instant the window closes; it is still returned.
 const raced=Buffer.from('raced message')
 const racer=remoteAdminSigner(pool,{address:admin,observe:async()=>{
  const {rows:[p]}=await pool.query("select id from hook_lab_owner_sign_requests where status='pending'")
  if(p)await store.submitSignature(p.id,signWith('admin',raced).toString('base64'))
  return {slot:999,blockHeight:1_000,nowMs:Date.now()}
 },sleep:async()=>{}})
 assert.ok(verifyEd25519(admin,raced,await racer.sign(raced,{review:reviewFor(raced)})))
}))
