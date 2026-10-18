// Deterministic canary policy only. No RPC, signing, sends or execution authority.
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import BN from 'bn.js'
import {PublicKey,TransactionInstruction,ComputeBudgetProgram} from '@solana/web3.js'
const check=(v,message='Canary governance evidence differs')=>{if(!v)throw Error(message)}
const sha=bytes=>createHash('sha256').update(bytes).digest()
const key=x=>new PublicKey(x),str=x=>x.toBase58()
export const canaryCommitment=(binding,state)=>sha(Buffer.concat([Buffer.from('hook-lab/governance-state/1\0'),binding.coder.types.encode('State',state)]))
export function canaryGateMatches(role,config,state,creationOpen=false){
 return state.gates.creation===(role==='launch'&&!creationOpen)&&state.gates.trading===(role==='swap')
  && config.paused===(role==='swap'||!creationOpen)
}
function accountBytes(binding,name,value,length){
 const discriminator=binding.idl.accounts.find(a=>a.name===name)?.discriminator,body=binding.coder.types.encode(name,value)
 check(discriminator&&body.length+8<=length)
 const bytes=Buffer.alloc(length);Buffer.from(discriminator).copy(bytes);body.copy(bytes,8);return bytes
}
export function canarySwapTransition(binding,gov,addresses){
 const s=gov.state,admin=str(s.roles.admin),program=str(s.program)
 check(PublicKey.isOnCurve(key(admin).toBytes())&&s.pending_admin===null,'Canary requires the existing direct admin signer')
 check(!s.gates.creation&&s.gates.trading&&BigInt(s.revision.toString())<=0xfffffffffffffffdn,'Canary initial gates or revision differ')
 const opened={...s,revision:s.revision.addn(1),gates:{creation:false,trading:false}}
 const closed={...s,revision:s.revision.addn(2),gates:{creation:false,trading:true}}
 const before=canaryCommitment(binding,s),during=canaryCommitment(binding,opened),after=canaryCommitment(binding,closed)
 const action=gates=>({SetGates:[gates]})
 const instruction=(expected,gates)=>new TransactionInstruction({programId:key(program),keys:[
  {pubkey:key(admin),isSigner:true,isWritable:false},
  {pubkey:key(addresses.swapConfig),isSigner:false,isWritable:true},
  {pubkey:key(addresses.swapGovernance),isSigner:false,isWritable:true}],
  data:binding.coder.instruction.encode('governance_action',{expected:[...expected],action:action(gates)})})
 return {admin,open:instruction(before,opened.gates),close:instruction(during,closed.gates),evidence:{
  schema:'repoing/canary-swap-transition/1',admin,actionIndex:3,openIndex:2,closeIndex:4,
  initialCommitment:before.toString('hex'),openCommitment:during.toString('hex'),finalCommitment:after.toString('hex'),
  initialRevision:s.revision.toString(),finalRevision:closed.revision.toString(),
  finalGovernanceDataBase64:accountBytes(binding,'Governance',{...gov,state:closed},348).toString('base64')},
  changes:timestamp=>[
   {program:s.program,config:s.config,actor:s.roles.admin,revision:opened.revision,timestamp:new BN(String(timestamp)),before:[...before],after:[...during],action:action(opened.gates)},
   {program:s.program,config:s.config,actor:s.roles.admin,revision:closed.revision,timestamp:new BN(String(timestamp)),before:[...during],after:[...after],action:action(closed.gates)}]}
}
/** Authenticate direct emit! governance logs, including root instruction attribution.
 * Govern uses emit!, not the trade's emit_cpi!. Never search arbitrary log prose for events. */
export function verifyCanaryGovernanceLogs({logs,binding,transition,instructions,timestamp}){
 check(Array.isArray(logs)&&instructions.length===5&&transition.evidence.actionIndex===3)
 const budget=ComputeBudgetProgram.programId.toBase58(),roots=instructions.map((ix,index)=>({program:ix.program,index})).filter(ix=>ix.program!==budget)
 const stack=[],events=[];let cursor=0,rootIndex=null
 for(const line of logs){
  check(typeof line==='string')
  const enter=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line)
  if(enter){
   const depth=Number(enter[2]);check(depth===stack.length+1)
   if(depth===1){
    if(enter[1]===budget){rootIndex=null}else{check(roots[cursor]?.program===enter[1]);rootIndex=roots[cursor++].index}
   }
   stack.push(enter[1]);continue
  }
  const exit=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed:.*)$/.exec(line)
  if(exit){check(stack.pop()===exit[1]);continue}
  if(stack.length!==1||stack[0]!==binding.idl.address||![2,4].includes(rootIndex)||!line.startsWith('Program data: '))continue
  const bytes=Buffer.from(line.slice(14),'base64'),event=binding.coder.events.decode(bytes.toString('base64'))
  check(event?.name==='GovernanceChanged')
  const def=binding.idl.events.find(x=>x.name===event.name)
  check(Buffer.concat([Buffer.from(def.discriminator),binding.coder.types.encode(event.name,event.data)]).equals(bytes))
  events.push({index:rootIndex,change:event.data.change})
 }
 check(stack.length===0&&cursor===roots.length&&events.length===2&&events[0].index===2&&events[1].index===4)
 const expected=transition.changes(timestamp)
 check(events.every((event,i)=>isDeepStrictEqual(binding.coder.types.encode('AuditEvent',event.change),binding.coder.types.encode('AuditEvent',expected[i]))))
}
