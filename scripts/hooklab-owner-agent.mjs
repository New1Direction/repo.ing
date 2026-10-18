#!/usr/bin/env node
// repo.ing owner approval agent. Runs on the owner's Mac while approvals are open.
//
//   export HOOK_OWNER_APPROVAL_TOKEN="$(security find-generic-password -s repoing-owner-agent -w)"
//   ~/Documents/ChatGPT/hooks-local-state/keyserve/with-custody-keys.sh \
//     "admin=$HOME/Library/Application Support/Hook Lab Custody/custody-da8970c2-1b18-4dc7-a4bc-9f096e42d5cc/primary:owner-admin" \
//     -- node scripts/hooklab-owner-agent.mjs --admin-key '{admin}' --creator-fee-bps 100 --rpc "$HELIUS_URL" --rpc2 https://solana-rpc.publicnode.com
//
// Commands while running: list | invite N [minutes] | decline N | pause | resume | quit
// It signs ONLY a launch message that decodes to the invited creator and coin, the approved fee,
// one create_launch_custom_v3 call, and a deadline that both RPC providers say is still open.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { Connection,PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { verifyLaunchSignRequest,decodeLookupTable,adminSignerFromKeypair } from '../src/hooklab-owner-agent.mjs'
const LAUNCH_PROGRAM='E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft',ADMIN='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',FEE_MODEL=2
const {values:opt}=parseArgs({options:{origin:{type:'string',default:'https://repo.ing'},'admin-key':{type:'string'},rpc:{type:'string'},rpc2:{type:'string'},
 'creator-fee-bps':{type:'string'},'invite-minutes':{type:'string',default:'15'},'confirm-each':{type:'boolean',default:false},'poll-ms':{type:'string',default:'1500'}}})
const die=message=>{console.error(message);process.exit(2)}
const token=process.env.HOOK_OWNER_APPROVAL_TOKEN
if(!token||token.length<32)die('Set HOOK_OWNER_APPROVAL_TOKEN (from your Keychain) first.')
if(!opt['admin-key']||!opt.rpc||!opt.rpc2)die('Required: --admin-key PATH --rpc URL --rpc2 URL (two independent providers).')
const creatorFeeBps=Number(opt['creator-fee-bps']);if(!Number.isInteger(creatorFeeBps)||creatorFeeBps<1||creatorFeeBps>10000)die('Required: --creator-fee-bps (the approved fee, e.g. 100).')
const admin=adminSignerFromKeypair(readFileSync(opt['admin-key'],'utf8'),ADMIN)   // read once from the key pipe; never logged
const connections=[new Connection(opt.rpc,'confirmed'),new Connection(opt.rpc2,'confirmed')]
const launchCoder=new BorshCoder(JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_launch.json',import.meta.url))))
const approved={launchProgram:LAUNCH_PROGRAM,admin:ADMIN,creatorFeeBps,feeModel:FEE_MODEL}
let accepting=true,queue={requests:[],signRequests:[]},busy=false
const handled=new Set()

async function api(body){
 const response=await fetch(new URL('/api/hook-lab/owner-approvals',opt.origin),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
 const json=await response.json().catch(()=>({}));if(!response.ok)throw Error(json.error??`HTTP ${response.status}`);return json
}
// The later (larger) of the two providers' views is used, so the agent never signs late.
async function live(){
 const views=await Promise.all(connections.map(async c=>({slot:await c.getSlot('confirmed'),blockHeight:await c.getBlockHeight('confirmed')})))
 if(Math.abs(views[0].slot-views[1].slot)>25)throw Error('RPC providers disagree on the current slot; not signing')
 return {slot:Math.max(...views.map(v=>v.slot)),blockHeight:Math.max(...views.map(v=>v.blockHeight))}
}
async function lookupTables(messageBase64){
 const {VersionedMessage}=await import('@solana/web3.js')
 const message=VersionedMessage.deserialize(Buffer.from(messageBase64,'base64'))
 return Promise.all(message.addressTableLookups.map(async l=>{
  const infos=await Promise.all(connections.map(c=>c.getAccountInfo(l.accountKey,'confirmed')))
  if(!infos[0]||!infos[1]||!infos[0].data.equals(infos[1].data))throw Error('Lookup table missing or providers disagree')
  return decodeLookupTable(l.accountKey.toBase58(),infos[0].data)
 }))
}
// The creator's on-chain grant must exist, be enabled, have quota, and outlive the invite.
async function grantStatus(creator){
 const [address]=PublicKey.findProgramAddressSync([Buffer.from('creator-authorization'),new PublicKey(creator).toBuffer()],new PublicKey(LAUNCH_PROGRAM))
 const info=await connections[0].getAccountInfo(address,'confirmed');if(!info)return {address:address.toBase58(),usable:false,reason:'no grant yet'}
 const g=launchCoder.accounts.decode('CreatorAuthorization',info.data),now=(await live()).slot
 const usable=g.enabled&&BigInt(g.consumed.toString())<BigInt(g.max_launches.toString())&&BigInt(g.expires_at_slot.toString())>BigInt(now)+1500n
 return {address:address.toBase58(),usable,reason:usable?'ok':`enabled=${g.enabled} consumed=${g.consumed}/${g.max_launches} expiresAtSlot=${g.expires_at_slot} now=${now}`}
}
function show(){
 console.log(`\n[${new Date().toLocaleTimeString()}] approvals ${accepting?'OPEN':'PAUSED'} as ${ADMIN}`)
 queue.requests.forEach((r,i)=>console.log(` ${i+1}. ${r.status.padEnd(9)} ${r.symbol.padEnd(10)} ${r.name.padEnd(32)} creator ${r.creator}${r.inviteExpiresAt?` invite until ${new Date(r.inviteExpiresAt).toLocaleTimeString()}`:''}`))
 if(!queue.requests.length)console.log(' (no launch requests)')
}
async function handleSignRequest(signRequest){
 if(handled.has(signRequest.id))return;handled.add(signRequest.id)
 const invited=queue.requests.find(r=>['invited','launching'].includes(r.status)&&r.creator===signRequest.context?.owner)
 try{
  if(!invited)throw Error('no invited request for this creator')
  const checked=verifyLaunchSignRequest({signRequest:{...signRequest,signer:signRequest.signer},invited,approved,lookupTables:await lookupTables(signRequest.messageBase64),live:await live()})
  console.log(`\nSIGN? ${checked.symbol} "${checked.name}" creator ${checked.creator} mint ${checked.mint} fee ${checked.creatorFeeBps} bps · ${checked.slotsLeft} slots / ${checked.blocksLeft} blocks left`)
  if(opt['confirm-each']&&!(await ask('Type yes to sign: ')==='yes'))throw Error('owner declined')
  await api({action:'sign',signRequestId:signRequest.id,signatureBase64:admin.signBase64(Buffer.from(signRequest.messageBase64,'base64'))})
  console.log(`SIGNED ${signRequest.messageSha256.slice(0,16)}…`)
 }catch(error){
  console.log(`REFUSED sign request ${signRequest.id}: ${error.message}`)
  await api({action:'decline-sign',signRequestId:signRequest.id}).catch(()=>{})
 }
}
const rl=createInterface({input:process.stdin,output:process.stdout});let asking=null
const ask=q=>new Promise(r=>{asking=r;rl.setPrompt(q);rl.prompt()})
rl.on('line',async line=>{
 if(asking){const r=asking;asking=null;return r(line.trim())}
 const [cmd,arg,arg2]=line.trim().split(/\s+/),pick=queue.requests[Number(arg)-1]
 try{
  if(cmd==='list')show()
  else if(cmd==='pause'){accepting=false;console.log('Paused: site shows approvals offline.')}
  else if(cmd==='resume'){accepting=true;console.log('Resumed.')}
  else if(cmd==='decline'&&pick)console.log((await api({action:'decline',requestId:pick.id})).request.status)
  else if(cmd==='invite'&&pick){
   const grant=await grantStatus(pick.creator)
   if(!grant.usable){console.log(`Creator grant not usable (${grant.reason}). Issue it first with the owner driver:\n  node scripts/hooklab-owner.mjs plan grant --creator ${pick.creator} --max-launches 1\nthen invite again.`);return}
   const minutes=Number(arg2??opt['invite-minutes'])
   console.log(`Invited until ${new Date((await api({action:'invite',requestId:pick.id,inviteSeconds:Math.round(minutes*60)})).request.inviteExpiresAt).toLocaleTimeString()}`)
  }
  else if(cmd==='quit'){accepting=false;await api({action:'heartbeat',accepting:false,agentAddress:ADMIN}).catch(()=>{});process.exit(0)}
  else console.log('Commands: list | invite N [minutes] | decline N | pause | resume | quit')
 }catch(error){console.log(`Failed: ${error.message}`)}
})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await api({action:'heartbeat',accepting:false,agentAddress:ADMIN}).catch(()=>{});process.exit(130)})
console.log(`Owner agent for ${opt.origin}. Admin ${ADMIN}. Approved creator fee ${creatorFeeBps} bps.`)
for(;;){
 try{
  const before=JSON.stringify(queue.requests)
  queue=await api({action:'heartbeat',accepting,agentAddress:ADMIN})
  if(JSON.stringify(queue.requests)!==before)show()
  if(!busy&&accepting){busy=true;try{for(const s of queue.signRequests)await handleSignRequest(s)}finally{busy=false}}
 }catch(error){console.log(`Heartbeat failed: ${error.message}`)}
 await new Promise(r=>setTimeout(r,Number(opt['poll-ms'])))
}
