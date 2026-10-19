#!/usr/bin/env node
// repo.ing owner approval agent. Runs on the owner's Mac while approvals are open.
//
//   export HOOK_OWNER_APPROVAL_TOKEN="$(security find-generic-password -s repoing-owner-agent -w)"
//   ~/Documents/ChatGPT/hooks-local-state/keyserve/with-custody-keys.sh \
//     "admin=$HOME/Library/Application Support/Hook Lab Custody/custody-da8970c2-1b18-4dc7-a4bc-9f096e42d5cc/primary:owner-admin" \
//     -- node scripts/hooklab-owner-agent.mjs --admin-key '{admin}' --rpc "$HELIUS_URL" --rpc2 https://solana-rpc.publicnode.com
//
// Commands while running: list | invite N [minutes] | decline N | reclaim | pause | resume | quit
// For each prepared launch it also creates that launch's lookup table with the admin key (about
// 0.0097 SOL rent per table, returned by `reclaim` after the launch finishes), after re-deriving the
// table's addresses itself. Journal (public data only): ~/.hooklab-owner/launch-tables.
// It signs ONLY a launch message that decodes to the invited creator and coin, the invited fee,
// one create_launch_custom_v3 call (or, once both RPC providers show the native-launches switch on, launch Config
// byte 186, one create_launch_custom_v4 with the native quote form and the mint's own launch, pool and fee policy),
// an on-chain mint policy with the invited cap and fee, the opening price (virtual quote) fixed with the invite, and
// a deadline that both RPC providers say is still open. Fee and cap menus come from the release code. With USD pricing on, `list` and
// `invite` show each invite's fixed price; check it before the launch reaches its signature.
import { mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { Connection,PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { verifyLaunchSignRequest,decodeLookupTable,adminSignerFromKeypair,launchMintFromMessage,policyAddress,invitedVirtualQuote,ownerRequestLines,checkBeforeInvite,checkAfterInvite } from '../src/hooklab-owner-agent.mjs'
import { readSolUsdSources } from '../src/sol-usd-sources.mjs'
import { readLiveLaunchBounds,readLiveLaunchConfigState } from '../src/hooklab-launch-bounds.mjs'
import { STANDARD_VIRTUAL_QUOTE,formatSol,ownerPricingLine } from '../src/hooklab-launch-pricing.mjs'
import { CREATOR_FEE_BPS_CHOICES,WALLET_CAP_BPS_CHOICES,percent } from '../src/hooklab-launch-menus.mjs'
import { UNSAFE_TEXT,coinImageUrl,coinLinks } from '../src/hooklab-coin-profile.mjs'
import { verifyTableRequest } from '../src/hooklab-owner-launch-tables.mjs'
import { ownerTableExecutor } from '../src/hooklab-owner-agent-tables.mjs'
import { productionArtifacts,productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'
const LAUNCH_PROGRAM='E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft',GATE_PROGRAM='BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb',ADMIN='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',FEE_MODEL=2
const {values:opt}=parseArgs({options:{origin:{type:'string',default:'https://repo.ing'},'admin-key':{type:'string'},rpc:{type:'string'},rpc2:{type:'string'},
 'invite-minutes':{type:'string',default:'15'},'confirm-each':{type:'boolean',default:false},'poll-ms':{type:'string',default:'1500'},'table-microlamports':{type:'string',default:'10000'}}})
const die=message=>{console.error(message);process.exit(2)}
const token=process.env.HOOK_OWNER_APPROVAL_TOKEN
if(!token||token.length<32)die('Set HOOK_OWNER_APPROVAL_TOKEN (from your Keychain) first.')
if(!opt['admin-key']||!opt.rpc||!opt.rpc2)die('Required: --admin-key PATH --rpc URL --rpc2 URL (two independent providers).')
const admin=adminSignerFromKeypair(readFileSync(opt['admin-key'],'utf8'),ADMIN)   // read once from the key pipe; never logged
const connections=[new Connection(opt.rpc,'confirmed'),new Connection(opt.rpc2,'confirmed')]
const launchCoder=new BorshCoder(JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_launch.json',import.meta.url))))
const approved={launchProgram:LAUNCH_PROGRAM,gateProgram:GATE_PROGRAM,admin:ADMIN,creatorFeeChoices:[...CREATOR_FEE_BPS_CHOICES],capChoices:[...WALLET_CAP_BPS_CHOICES],feeModel:FEE_MODEL}
const {base,idls}=productionArtifacts(),envelope={json:productionProfileJson(base),idls:Object.fromEntries(Object.entries(idls).map(([role,bytes])=>[role,bytes.toString('base64')]))}
const tables=ownerTableExecutor({connections,admin,journalDir:path.join(homedir(),'.hooklab-owner','launch-tables'),microLamports:Number(opt['table-microlamports']),log:console.log})
let accepting=true,queue={requests:[],signRequests:[],tableRequests:[]},busy=false,lastHeartbeatOk=0
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
// The mint's PolicyV2, read from both providers; they must return identical bytes.
async function mintPolicy(mint){
 const address=policyAddress(GATE_PROGRAM,mint),infos=await Promise.all(connections.map(c=>c.getAccountInfo(new PublicKey(address),'confirmed')))
 if(!infos[0]||!infos[1]||!infos[0].data.equals(infos[1].data)||!infos[0].owner.equals(infos[1].owner))throw Error('Mint policy missing or providers disagree')
 return {address,owner:infos[0].owner.toBase58(),data:infos[0].data}
}
// The launch config a launch message names (account 29), read from both providers; they must return identical bytes.
async function selectedLaunchConfig(messageBase64,lookupTables){
 const {VersionedMessage}=await import('@solana/web3.js')
 const message=VersionedMessage.deserialize(Buffer.from(messageBase64,'base64')),keys=message.getAccountKeys({addressLookupTableAccounts:lookupTables})
 const launches=message.compiledInstructions.filter(ix=>keys.get(ix.programIdIndex).toBase58()===LAUNCH_PROGRAM)
 if(launches.length!==1||launches[0].accountKeyIndexes.length<30)throw Error('expected exactly one launch instruction')
 const address=keys.get(launches[0].accountKeyIndexes[29]),infos=await Promise.all(connections.map(c=>c.getAccountInfo(address,'confirmed')))
 if(!infos[0]||!infos[1]||!infos[0].data.equals(infos[1].data)||!infos[0].owner.equals(infos[1].owner))throw Error('Selected launch config missing or providers disagree')
 return {address:address.toBase58(),owner:infos[0].owner.toBase58(),data:infos[0].data}
}
// The creator's on-chain grant must exist, be enabled, have quota, and outlive the invite.
async function grantStatus(creator){
 const [address]=PublicKey.findProgramAddressSync([Buffer.from('creator-authorization'),new PublicKey(creator).toBuffer()],new PublicKey(LAUNCH_PROGRAM))
 const info=await connections[0].getAccountInfo(address,'confirmed');if(!info)return {address:address.toBase58(),usable:false,reason:'no grant yet'}
 const g=launchCoder.accounts.decode('CreatorAuthorization',info.data),now=(await live()).slot
 const usable=g.enabled&&BigInt(g.consumed.toString())<BigInt(g.max_launches.toString())&&BigInt(g.expires_at_slot.toString())>BigInt(now)+1500n
 return {address:address.toBase58(),usable,reason:usable?'ok':`enabled=${g.enabled} consumed=${g.consumed}/${g.max_launches} expiresAtSlot=${g.expires_at_slot} now=${now}`}
}
// Creator-supplied text is shown with control and bidi characters replaced, so it cannot fake list rows.
const printable=value=>String(value).replace(new RegExp(UNSAFE_TEXT.source,'g'),'\ufffd')
function show(){
 console.log(`\n[${new Date().toLocaleTimeString()}] approvals ${accepting?'OPEN':'PAUSED'} as ${ADMIN}`)
 queue.requests.forEach((r,i)=>{
  console.log(` ${i+1}. ${r.status.padEnd(9)} ${printable(r.symbol).padEnd(10)} ${printable(r.name).padEnd(32)} fee ${percent(r.creatorFeeBps)} cap ${percent(r.capBps)} creator ${r.creator}${r.inviteExpiresAt?` invite until ${new Date(r.inviteExpiresAt).toLocaleTimeString()}`:''}`)
  // Review the image and links before inviting: they are what repo.ing will show for this coin.
  if(r.profile)console.log(`    image ${coinImageUrl(opt.origin,r.id)}${Object.entries(coinLinks(r.profile)).map(([k,v])=>` · ${k} ${v}`).join('')}${r.profile.description?`\n    ${JSON.stringify(printable(r.profile.description))}`:''}`)
  for(const line of ownerRequestLines(r))console.log(line)
 })
 if(!queue.requests.length)console.log(' (no launch requests)')
}
// Only requests this agent invited (ledger on disk) can make the admin pay for a table: at most one
// table per invited request, and only while the creator's on-chain grant still allows the launch.
const inviteLedgerPath=path.join(homedir(),'.hooklab-owner','invited.json')
const invitedByMe=()=>{try{return JSON.parse(readFileSync(inviteLedgerPath,'utf8'))}catch(error){if(error.code==='ENOENT')return {};throw error}}
function recordInvite(request){
 mkdirSync(path.dirname(inviteLedgerPath),{recursive:true,mode:0o700})
 const ledger={...invitedByMe(),[request.id]:{creator:request.creator,name:request.name,symbol:request.symbol,uri:request.uri,creatorFeeBps:request.creatorFeeBps,capBps:request.capBps,
  virtualQuote:invitedVirtualQuote(request),invitedAt:new Date().toISOString()}}
 writeFileSync(`${inviteLedgerPath}.next`,JSON.stringify(ledger,null,1),{mode:0o600});renameSync(`${inviteLedgerPath}.next`,inviteLedgerPath)
}
// The server's copy of an invite must still equal what this agent invited, opening price included. Ledger entries
// written before USD pricing carry no price: those invites launch at the standard quote.
const INVITE_FIELDS=['creator','name','symbol','uri','creatorFeeBps','capBps']
const ledgerQuote=mine=>mine.virtualQuote??STANDARD_VIRTUAL_QUOTE
const matchesLedger=invited=>{const mine=invited&&invitedByMe()[invited.id]
 return !!mine&&INVITE_FIELDS.every(k=>mine[k]===invited[k])&&ledgerQuote(mine)===(invited.pricing?.virtualQuote??STANDARD_VIRTUAL_QUOTE)}
// Waiting states log once a minute and back off, instead of spamming or declining for good.
const waits=new Map()
function wait(id,reason){const w=waits.get(id)??{n:0,loggedAt:0};w.n++;w.until=Date.now()+Math.min(60_000,1_500*2**Math.min(w.n,6))
 if(Date.now()-w.loggedAt>60_000){console.log(`Table request waiting: ${reason}`);w.loggedAt=Date.now()};waits.set(id,w)}
let tableJob=null
async function handleTableRequest(tableRequest){
 if(handled.has(`table:${tableRequest.preparationId}`))return
 const invited=queue.requests.find(r=>r.id===tableRequest.launchRequestId)
 const decline=async reason=>{handled.add(`table:${tableRequest.preparationId}`);console.log(`REFUSED table request for ${tableRequest.creator}: ${reason}`)
  await api({action:'decline-table',preparationId:tableRequest.preparationId}).catch(()=>{})}
 // Not in this agent's invite ledger: never pay for it, but do not decline for good either (the owner decides).
 const mine=invitedByMe()[tableRequest.launchRequestId]
 if(!mine)return wait(tableRequest.preparationId,`request ${tableRequest.launchRequestId} is not in this agent's invite ledger; nothing will be paid for it`)
 if(!matchesLedger(invited)||mine.creator!==tableRequest.creator)return decline('the request differs from what this agent invited')
 let configBytes,grant
 try{
  const infos=await Promise.all(connections.map(c=>c.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from('config')],new PublicKey(LAUNCH_PROGRAM))[0],'finalized')))
  if(!infos[0]||!infos[1]||!infos[0].data.equals(infos[1].data))throw Error('launch config missing or providers disagree')
  configBytes=infos[0].data;grant=await grantStatus(tableRequest.creator)
 }catch(error){return wait(tableRequest.preparationId,error.message)}
 // A missing or nearly expired grant can be fixed with customer-grant; wait instead of declining.
 if(!grant.usable)return wait(tableRequest.preparationId,`creator grant not usable (${grant.reason}); run customer-grant for ${tableRequest.creator}`)
 let checked
 try{checked=verifyTableRequest({tableRequest,invited:{...invited,virtualQuote:ledgerQuote(mine)},envelope,launchConfigBytes:configBytes,adminAddress:ADMIN})}catch(error){return decline(error.message)}
 console.log(`\nTABLE for ${invited.symbol} creator ${invited.creator} mint ${tableRequest.launchRequest.mint}: ${checked.inventory.length} addresses${checked.nativeLaunches?' (native-SOL launch)':''}`)
 const table=await tables.ensure({preparationId:tableRequest.preparationId,launchRequestId:invited.id,creator:invited.creator,mint:tableRequest.launchRequest.mint,...checked})
 await api({action:'table',preparationId:tableRequest.preparationId,tableAddress:table})
 handled.add(`table:${tableRequest.preparationId}`);waits.delete(tableRequest.preparationId);console.log(`TABLE READY ${table}`)
}
// Table creation takes ~20-40 s; it runs beside the heartbeat so the site keeps showing the owner online.
function startTableJobs(){
 if(tableJob||!accepting)return
 const next=(queue.tableRequests??[]).find(t=>!handled.has(`table:${t.preparationId}`)&&!(waits.get(t.preparationId)?.until>Date.now()))
 if(!next)return
 tableJob=handleTableRequest(next).catch(error=>wait(next.preparationId,`${error.message}; the same journaled transactions resume`)).finally(()=>{tableJob=null})
}
async function handleSignRequest(signRequest){
 if(handled.has(signRequest.id))return;handled.add(signRequest.id)
 const invited=queue.requests.find(r=>['invited','launching'].includes(r.status)&&r.creator===signRequest.context?.owner)
 try{
  if(!invited)throw Error('no invited request for this creator')
  if(!matchesLedger(invited))throw Error('the server\'s invite differs from what this agent invited')
  const tables=await lookupTables(signRequest.messageBase64),policy=await mintPolicy(launchMintFromMessage(signRequest.messageBase64,tables,LAUNCH_PROGRAM))
  // The launch route (byte 186) and every account the launch may name come from this Mac's own two-provider read of the
  // launch Config and its pinned envelope, never from the server.
  const {bytes:launchConfigBytes,nativeLaunches}=await readLiveLaunchConfigState(connections),selectedConfig=await selectedLaunchConfig(signRequest.messageBase64,tables)
  const checked=verifyLaunchSignRequest({signRequest,invited:{...invited,virtualQuote:ledgerQuote(invitedByMe()[invited.id])},approved,lookupTables:tables,policy,live:await live(),
   nativeLaunches,envelope,launchConfigBytes,selectedConfig})
  console.log(`\nSIGN? ${checked.quoteForm?'native-SOL launch ':''}${checked.symbol} "${checked.name}" creator ${checked.creator} mint ${checked.mint} fee ${percent(checked.creatorFeeBps)} cap ${percent(checked.capBps)} opens ${formatSol(checked.virtualQuote)} virtual · ${checked.slotsLeft} slots / ${checked.blocksLeft} blocks left`)
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
   if(!grant.usable){console.log(`Creator grant not usable (${grant.reason}). Issue it first with the owner driver:\n  node scripts/hooklab-owner.mjs plan customer-grant --creator ${pick.creator} --rpc URL --rpc2 URL\nreview the preview, then: node scripts/hooklab-owner.mjs execute customer-grant --creator ${pick.creator} --message-sha256 <preview sha> --key payer=<pipe> --key admin=<pipe> --rpc URL --rpc2 URL\nthen invite again.`);return}
   const minutes=Number(arg2??opt['invite-minutes'])
   // First this Mac's own SOL read (when the server prices invites) and the live launch-config limits: never ask for
   // an invite the chain would refuse, since it would hold the single invite slot until it expired.
   const priced=pick.pricing!==undefined,ownReadings=priced?await readSolUsdSources():[],bounds=await readLiveLaunchBounds(connections)
   checkBeforeInvite({priced,ownReadings,bounds})
   const {request:confirmed}=await api({action:'invite',requestId:pick.id,inviteSeconds:Math.round(minutes*60)})
   if(!INVITE_FIELDS.every(k=>confirmed[k]===pick[k]))throw Error('server returned a different invite')
   // A price that does not re-derive from its sources, that this Mac's read does not confirm, or that the same limits
   // refuse is never recorded, so nothing is ever signed for this invite.
   try{checkAfterInvite({confirmed,ownReadings,bounds})}
   catch(error){throw Error(`${error.message}; this invite is NOT recorded and will not be signed (decline ${arg} to release it)`)}
   recordInvite(confirmed)
   console.log(`Invited until ${new Date(confirmed.inviteExpiresAt).toLocaleTimeString()}${confirmed.pricing?`\n  ${ownerPricingLine(confirmed.pricing)}`:''}`)
  }
  else if(cmd==='reclaim'){
   // Only with a fresh view of open requests: a stale or empty queue would look like every launch had finished.
   if(Date.now()-lastHeartbeatOk>10_000)throw Error('no fresh heartbeat; reclaim refuses to guess which launches are finished')
   if(tableJob)throw Error('a table is being created; reclaim after it finishes')
   const lines=await tables.reclaim(new Set(queue.requests.map(r=>r.id)));console.log(lines.length?lines.join('\n'):'Nothing to reclaim.')}
  else if(cmd==='quit'){accepting=false;await api({action:'heartbeat',accepting:false,agentAddress:ADMIN}).catch(()=>{});process.exit(0)}
  else console.log('Commands: list | invite N [minutes] | decline N | reclaim | pause | resume | quit')
 }catch(error){console.log(`Failed: ${error.message}`)}
})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await api({action:'heartbeat',accepting:false,agentAddress:ADMIN}).catch(()=>{});process.exit(130)})
console.log(`Owner agent for ${opt.origin}. Admin ${ADMIN}. Fee menu ${CREATOR_FEE_BPS_CHOICES.map(percent).join('/')}; cap menu ${WALLET_CAP_BPS_CHOICES.map(percent).join('/')}.`)
for(;;){
 try{
  const before=JSON.stringify(queue.requests)
  queue=await api({action:'heartbeat',accepting,agentAddress:ADMIN});lastHeartbeatOk=Date.now()
  if(JSON.stringify(queue.requests)!==before)show()
  startTableJobs()
  if(!busy&&accepting){busy=true;try{for(const s of queue.signRequests)await handleSignRequest(s)}finally{busy=false}}
 }catch(error){console.log(`Heartbeat failed: ${error.message}`)}
 await new Promise(r=>setTimeout(r,Number(opt['poll-ms'])))
}
