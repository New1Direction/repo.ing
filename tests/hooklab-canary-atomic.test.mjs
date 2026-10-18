import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {AddressLookupTableAccount,ComputeBudgetProgram,TransactionMessage,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import {compileCanaryMaxWalletLaunchReview,compileMaxWalletLaunchReview} from '../src/hooklab-max-wallet-launch.mjs'
import {compileCanaryInclusiveMaxWalletSwapReview,compileInclusiveMaxWalletSwapReview,inclusiveMaxWalletSwapInventory} from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import {deriveCanaryMaxWalletLaunchPostconditions} from '../src/hooklab-max-wallet-launch-settlement.mjs'
import {collectCanaryInclusiveTradeSettlement,deriveCanaryInclusiveTradePostconditions} from '../src/hooklab-inclusive-trade-settlement.mjs'
import {inspectHookLabMessage} from '../src/hooklab-message-boundary.mjs'
import {canaryCommitment} from '../src/hooklab-canary-policy.mjs'
import {makeCanaryState,canaryCollectorBindings,localTestEnvironment,pk,pda} from './fixtures/hooklab-canary.mjs'

function runner(){
 const child=spawn(process.env.HOOKLAB_CANARY_PYTHON??'python3',['-u',fileURLToPath(new URL('./fixtures/hooklab-canary-svm.py',import.meta.url))],{
  env:{PATH:process.env.PATH,PYTHONPATH:process.env.HOOKLAB_CANARY_PYTHONPATH??'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']})
 const pending=[];let stderr=''
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000)})
 createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(!p)return;try{const value=JSON.parse(line);if(value.runnerError)p.reject(Error(`${value.runnerError}: ${value.message}`));else p.resolve(value)}catch(e){p.reject(e)}})
 child.on('error',e=>{while(pending.length)pending.shift().reject(e)})
 child.on('exit',code=>{while(pending.length)pending.shift().reject(Error(`Isolated SVM exited ${code}: ${stderr}`))})
 return {call:(op,fields={})=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({op,...fields})+'\n')}),close:()=>child.stdin.end()}
}
const elfDirectory=process.env.HOOKLAB_CANARY_ELF_DIR

test('canary closes trading atomically with real signed SBF execution and authenticated index-3 receipts', {skip:!elfDirectory&&process.env.HOOKLAB_CANARY_REQUIRED!=='true',timeout:120000},async t=>{
 assert.ok(elfDirectory,'HOOKLAB_CANARY_ELF_DIR is required for canary acceptance; skipping is not a release gate')
 const saved=Object.fromEntries(Object.keys(localTestEnvironment()).map(k=>[k,process.env[k]]))
 Object.assign(process.env,localTestEnvironment())
 const svm=runner();t.after(()=>{svm.close();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}})
 const profile=JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json',import.meta.url)))
 const names={launch:'bordrless_launch',swap:'bordrless_swap',gate:'hook_max_wallet',token:'bordrless_token'}
 const init=await svm.call('init',{scope:'isolated-canary-svm/1',programs:Object.entries(names).map(([role,name])=>({address:profile.programs[role],path:`${elfDirectory}/${name}.so`,sha256:role==='token'?profile.dependencyObservation.tokenElfSha256:profile.elfSha256[role]}))})
 const state=makeCanaryState({elfDirectory,roles:init.roles,blockhash:init.blockhash}),a=state.addresses,roles=init.roles
 // ProgramData first; no inherited validator ledger, historical snapshot or production custody.
 const initial=[...state.accounts].map(([address,account])=>({address,account})).sort((x,y)=>Number(x.account.executable)-Number(y.account.executable))
 await svm.call('set',{accounts:initial})
 let blockhash=init.blockhash
 const executed=new Map(),collectorBindings=canaryCollectorBindings(state)
 const allAddresses=()=>[...new Set([...state.accounts.keys(),...Object.values(a),roles.mint,roles.creator,roles.admin,roles.outsider])]
 async function sync(){const result=await svm.call('get',{addresses:allAddresses()});for(const row of result.accounts){if(row.account)state.accounts.set(row.address,row.account);else state.accounts.delete(row.address)}return result}
 const lookup=new AddressLookupTableAccount({key:pk(state.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(state.lookupTable.dataBase64,'base64'))})
 const message=instructions=>new TransactionMessage({payerKey:pk(roles.creator),recentBlockhash:blockhash,instructions}).compileToV0Message([lookup])
 const send=async(msg,options={})=>{
  const result=await svm.call('send',{messageBase64:Buffer.from(msg.serialize()).toString('base64'),...options})
  if(result.historyPresent&&!executed.has(result.signature))executed.set(result.signature,result)
  return result
 }
 const decompile=plan=>TransactionMessage.decompile(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64')),{addressLookupTableAccounts:[lookup]}).instructions
 async function expire(){blockhash=(await svm.call('expire')).blockhash}
 const report={scope:'fresh-in-memory-SVM-only',signatureVerification:true,blockhashVerification:true,programs:state.artifacts.map(({role,sha256})=>({role,sha256})),checks:[]}
 const note=(name,result)=>report.checks.push({name,error:result?.error??null,units:result?.units??null,wireBytes:result?.wireBytes??null,logBytes:result?.logs?.reduce((n,line)=>n+Buffer.byteLength(line),0)??null})
 // Only the inclusion/transport framing is synthetic. Wire, signatures, keys,
 // logs, CPI events, balances and account bytes come from the real executed bank.
 function connections(alter=()=>{}){
  return state.profile.providers.map((provider,i)=>({provider,connection:{
   rpcEndpoint:[localTestEnvironment().HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY,localTestEnvironment().HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY][i],
   getGenesisHash:async()=>JSON.parse(state.profile.json).genesisHash,
   getTransaction:async signature=>{
    const result=executed.get(signature);if(!result)return null
    const signed=VersionedTransaction.deserialize(Buffer.from(result.wireBase64,'base64'))
    const tx={slot:result.slot,transaction:{message:signed.message,signatures:signed.signatures.map(s=>bs58.encode(s))},
     meta:{err:result.error,fee:result.fee,preBalances:[...result.preBalances],postBalances:[...result.postBalances],
      loadedAddresses:Object.fromEntries(Object.entries(result.loadedAddresses).map(([k,v])=>[k,v.map(pk)])),
      logMessages:[...result.logs],innerInstructions:result.innerInstructions.map(group=>({index:group.index,instructions:group.instructions.map(({dataBase64,...ix})=>({...ix,accounts:[...ix.accounts],data:bs58.encode(Buffer.from(dataBase64,'base64'))}))}))}}
    alter(tx);return tx
   },
   getBlockSignatures:async()=>({blockhash:roles.table,previousBlockhash:roles.config,parentSlot:99,blockHeight:100,signatures:[...executed.keys()]}),
   getMultipleAccountsInfoAndContext:async keys=>{
    const snapshot=await svm.call('get',{addresses:keys.map(k=>k.toBase58())})
    return {context:{slot:snapshot.slot},value:snapshot.accounts.map(({account})=>account?{owner:pk(account.owner),executable:account.executable,data:Buffer.from(account.dataBase64,'base64')}:null)}
   },
  }}))
 }
 const collect=(input,result,alter)=>collectCanaryInclusiveTradeSettlement({...collectorBindings,connections:connections(alter),
  settlementContext:{schema:'repoing/canary-inclusive-trade-settlement-context/1',compilationInput:input},
  review:compileCanaryInclusiveMaxWalletSwapReview(input).review,signedTransactionBase64:result.wireBase64,signature:result.signature})
 function decoded(role,type,address){return state.bindings[role].coder.accounts.decode(type,Buffer.from(state.accounts.get(address).dataBase64,'base64'))}
 function govAction(role,closed){const program=profile.programs[role],gov=decoded(role,'Governance',pda(program,'governance'))
  return state.instruction(role,'governance_action',{expected:[...canaryCommitment(state.bindings[role],gov.state)],action:{SetGates:[{creation:role==='launch'&&closed,trading:role==='swap'&&closed}]}},{authority:roles.admin})}
 const launch=compileCanaryMaxWalletLaunchReview(state.launchInput)
 await t.test('ordinary launch compiler still refuses the mixed state and canary cannot bypass schema',()=>{
  assert.throws(()=>compileMaxWalletLaunchReview(state.launchInput),/pause/)
  assert.throws(()=>compileMaxWalletLaunchReview({...state.launchInput,canary:true}))
  const tooLarge=structuredClone(state.launchInput);tooLarge.lookupTable=null
  assert.throws(()=>compileCanaryMaxWalletLaunchReview(tooLarge),/overrun|1232|maximum|mismatch|large/i)
 })
 await t.test('guarded launch executes while swap stays paused',async()=>{
  const result=await send(VersionedMessage.deserialize(Buffer.from(launch.review.messageBase64,'base64')))
  assert.equal(result.error,null,JSON.stringify(result));assert.ok(result.wireBytes<=1232);assert.ok(result.units>0&&result.units<=1400000)
  await sync()
  const expected=deriveCanaryMaxWalletLaunchPostconditions({schema:'repoing/canary-max-wallet-launch-settlement-context/1',compilationInput:state.launchInput},{slot:100,timestamp:1800000000})
  for(const want of expected.accounts){const actual=state.accounts.get(want.address);assert.equal(actual.owner,want.owner,want.address);assert.equal(actual.dataBase64,want.dataBase64,want.address)}
  assert.equal(decoded('swap','Config',a.swapConfig).paused,true)
  note('launch-trading-paused',result)
 })
 await expire()
 const close=await send(message([ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),govAction('launch',true)]))
 assert.equal(close.error,null,JSON.stringify(close));await sync();assert.equal(decoded('launch','Config',a.launchConfig).paused,true)
 state.holding(roles.mint,roles.creator,0);state.holding(profile.quoteMint,roles.creator,10000000)
 state.holding(roles.mint,roles.outsider,0);state.holding(profile.quoteMint,roles.outsider,10000000)
 await svm.call('set',{accounts:[...state.accounts].filter(([address])=>[pda(profile.programs.token,'holding',pk(roles.mint).toBuffer(),pk(roles.creator).toBuffer()),pda(profile.programs.token,'holding',pk(profile.quoteMint).toBuffer(),pk(roles.creator).toBuffer()),pda(profile.programs.token,'holding',pk(roles.mint).toBuffer(),pk(roles.outsider).toBuffer()),pda(profile.programs.token,'holding',pk(profile.quoteMint).toBuffer(),pk(roles.outsider).toBuffer())].includes(address)).map(([address,account])=>({address,account}))})
 await sync();await expire()
 let ci=state.tradeInput('buy','1000200',blockhash),plan=compileCanaryInclusiveMaxWalletSwapReview(ci)
 await t.test('ordinary swap stays closed; new policy requires creator and bound recipient',()=>{
  assert.throws(()=>compileInclusiveMaxWalletSwapReview(ci),/pause/)
  const injected=structuredClone(ci);injected.canary=true;assert.throws(()=>compileInclusiveMaxWalletSwapReview(injected))
  for(const change of [{recipient:roles.outsider},{trader:roles.outsider,recipient:roles.outsider,feePayer:roles.outsider}]){
   const outsider=structuredClone(ci);Object.assign(outsider.request,change)
   const inventory=inclusiveMaxWalletSwapInventory(JSON.parse(ci.profile.json),outsider.request)
   for(const observation of outsider.observations)observation.accounts=inventory.map(address=>({address,account:structuredClone(state.accounts.get(address)??null)}))
   assert.throws(()=>compileCanaryInclusiveMaxWalletSwapReview(outsider),/Canary/)
  }
  const mismatch=structuredClone(ci)
  for(const observation of mismatch.observations){const row=observation.accounts.find(x=>x.address===a.swapGovernance),bytes=Buffer.from(row.account.dataBase64,'base64'),v=state.bindings.swap.coder.accounts.decode('Governance',bytes);v.state.gates.trading=false;state.bindings.swap.coder.types.encode('Governance',v).copy(bytes,8);row.account.dataBase64=bytes.toString('base64')}
  assert.throws(()=>compileCanaryInclusiveMaxWalletSwapReview(mismatch),/Governance/)
 })
 const protectedAddresses=[a.launchConfig,a.swapConfig,a.launchGovernance,a.swapGovernance,a.pool,a.baseVault,a.quoteVault,a.launchQuote,a.authorization,pda(profile.programs.token,'holding',pk(roles.mint).toBuffer(),pk(roles.creator).toBuffer()),pda(profile.programs.token,'holding',pk(profile.quoteMint).toBuffer(),pk(roles.creator).toBuffer())]
 const protectedState=async()=> (await svm.call('get',{addresses:protectedAddresses})).accounts
 async function refuses(name,instructions,options={},expected=/./){
  await expire();const before=await protectedState(),result=await send(message(instructions),options)
  assert.notEqual(result.error,null,`${name} unexpectedly executed`);assert.match(result.error+'\n'+result.logs.join('\n'),expected)
  assert.deepEqual(await protectedState(),before,`${name} changed protected state`);note(name,result)
  return result
 }
 await t.test('missing admin signature cannot open the gate',async()=>{
  await refuses('missing-admin-signature',decompile(plan),{missing:[roles.admin]},/SignatureFailure/)
 })
 await t.test('outside signer cannot authorize governance',async()=>{
  const instructions=decompile(plan);instructions[2].keys[0].pubkey=pk(roles.outsider)
  await refuses('unauthorized-gate-opener',instructions,{},/GovernanceRejected/)
 })
 await t.test('outside wallet direct buys and sells fail while closed',async()=>{
  for(const side of ['buy','sell']){const instructions=decompile(plan),swap=instructions[3],data=state.bindings.swap.coder.instruction.decode(swap.data).data
   data.args.direction=side==='buy'?1:0;data.args.amount_in=new BN(1)
   swap.data=state.bindings.swap.coder.instruction.encode('swap',data)
   for(const meta of swap.keys){if(meta.pubkey.equals(pk(roles.creator)))meta.pubkey=pk(roles.outsider);for(const mint of [roles.mint,profile.quoteMint])if(meta.pubkey.equals(pk(pda(profile.programs.token,'holding',pk(mint).toBuffer(),pk(roles.creator).toBuffer()))))meta.pubkey=pk(pda(profile.programs.token,'holding',pk(mint).toBuffer(),pk(roles.outsider).toBuffer()))}
   await refuses(`outside-direct-${side}`,[...instructions.slice(0,2),swap],{},/Paused/)
  }
 })
 await t.test('failed minimum output rolls back opening and all asset changes',async()=>{
  const instructions=decompile(plan),decoded=state.bindings.swap.coder.instruction.decode(instructions[3].data).data
  decoded.args.min_amount_out=new BN('18446744073709551615');instructions[3].data=state.bindings.swap.coder.instruction.encode('swap',decoded)
  await refuses('swap-failure-rollback',instructions,{},/Slippage|Minimum|Output|TooLittle/)
 })
 await t.test('failing closing commitment rolls back a swap that reached execution',async()=>{
  const instructions=decompile(plan);instructions[4].data[9]^=1
  const result=await refuses('closing-failure-rollback',instructions,{},/GovernanceRejected/)
  assert.match(result.error,/\(\(4,/)
 })
 await t.test('compute exhaustion never leaves the gate open',async()=>{
  const instructions=decompile(plan);instructions[0]=ComputeBudgetProgram.setComputeUnitLimit({units:50000})
  const result=await refuses('compute-failure-rollback',instructions,{},/ComputationalBudgetExceeded|exceeded CUs|compute units/)
  assert.match(result.error,/\(\(3,/)
 })
 await t.test('an intervening guardian pause invalidates the opening commitment without reopening',async()=>{
  await expire()
  const staleCi=state.tradeInput('buy','1000200',blockhash),stalePlan=compileCanaryInclusiveMaxWalletSwapReview(staleCi)
  const pause=state.instruction('swap','governance_action',{expected:null,action:{Pause:[{creation:false,trading:true}]}},{authority:roles.guardian})
  const result=await send(message([ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),pause]))
  assert.equal(result.error,null,JSON.stringify(result));await sync()
  const before=await protectedState(),stale=await send(VersionedMessage.deserialize(Buffer.from(stalePlan.review.messageBase64,'base64')))
  assert.match(stale.error,/InstructionErrorCustom\(6100\)/);assert.match(stale.error,/\(\(2,/)
  assert.deepEqual(await protectedState(),before)
  assert.equal((await collect(staleCi,stale)).status,'finalized-failure')
  note('stale-opening-commitment',stale)
 })
 await expire();await sync();ci=state.tradeInput('buy','1000200',blockhash);plan=compileCanaryInclusiveMaxWalletSwapReview(ci)
 let buyResult
 await t.test('a signed but unexecuted message cannot acquire settlement from supplied receipt data',async()=>{
  const unexecuted=await svm.call('sign',{messageBase64:plan.review.messageBase64})
  assert.equal(unexecuted.historyPresent,false)
  const proof=await collectCanaryInclusiveTradeSettlement({...collectorBindings,connections:connections(),
   settlementContext:{schema:'repoing/canary-inclusive-trade-settlement-context/1',compilationInput:ci},
   review:plan.review,signedTransactionBase64:unexecuted.wireBase64,signature:unexecuted.signature,
   transaction:{error:null,logs:['fabricated caller evidence'],finalTradingPaused:true}})
  assert.equal(proof.status,'unresolved');assert.equal(proof.tradingPausedAtCommit,undefined)
 })
 await t.test('atomic buy commits only closed gates and index-3 fee/transfer proof',async()=>{
  buyResult=await send(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64')))
  assert.equal(buyResult.error,null,JSON.stringify(buyResult));assert.ok(buyResult.wireBytes<=1232);assert.ok(buyResult.units>0&&buyResult.units<=ci.limits.computeUnitLimit)
  const proof=await collect(ci,buyResult)
  assert.equal(proof.status,'finalized-success');assert.equal(proof.tradingPausedAtCommit,true);assert.equal(proof.governanceTransitionsVerified,true)
  assert.ok(buyResult.logs.reduce((n,line)=>n+Buffer.byteLength(line)+1,0)<10000)
  assert.equal(proof.quote.grossCreatorFee,'10002');assert.equal(proof.quote.protocolFee,'2500');assert.equal(proof.quote.netCreatorFee,'7502')
  await sync();assert.equal(decoded('swap','Config',a.swapConfig).paused,true);assert.equal(decoded('launch','Config',a.launchConfig).paused,true)
  const expected=deriveCanaryInclusiveTradePostconditions(ci,1800000000)
  for(const row of expected){if(row.account){assert.equal(state.accounts.get(row.address)?.dataBase64,row.account.dataBase64,row.address)}}
  note('atomic-buy-index3',buyResult)
 })
 await t.test('a fresh review cannot authorize a second canary buy',()=>{
  assert.throws(()=>compileCanaryInclusiveMaxWalletSwapReview(state.tradeInput('buy','1000200',blockhash)))
 })
 await t.test('receipt rejects index-2 attribution, absent closing proof and altered signed envelope',async()=>{
  assert.equal((await collect(ci,buyResult,tx=>{for(const group of tx.meta.innerInstructions)if(group.index===3)group.index=2})).status,'unresolved')
  assert.equal((await collect(ci,buyResult,tx=>{tx.meta.logMessages=tx.meta.logMessages.slice(0,-3)})).status,'unresolved')
  const changed=VersionedTransaction.deserialize(Buffer.from(buyResult.wireBase64,'base64'));changed.message.compiledInstructions.pop()
  assert.equal((await collect(ci,{...buyResult,wireBase64:Buffer.from(changed.serialize()).toString('base64')})).status,'unresolved')
 })
 await t.test('replaying the same signed buy cannot duplicate a transaction',async()=>{
  const before=await protectedState(),result=await send(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64')))
  assert.match(result.error,/AlreadyProcessed/);assert.deepEqual(await protectedState(),before);note('duplicate-buy-rejected',result)
 })
 await expire();await sync()
 const acquired=decoded('token','Holding',pda(profile.programs.token,'holding',pk(roles.mint).toBuffer(),pk(roles.creator).toBuffer())).amount.toString()
 const sellCi=state.tradeInput('sell',acquired,blockhash),sellPlan=compileCanaryInclusiveMaxWalletSwapReview(sellCi)
 await t.test('atomic sell works with creation closed and restores trading pause',async()=>{
  const result=await send(VersionedMessage.deserialize(Buffer.from(sellPlan.review.messageBase64,'base64')))
  assert.equal(result.error,null,JSON.stringify(result));assert.ok(result.wireBytes<=1232);assert.ok(result.units>0&&result.units<=sellCi.limits.computeUnitLimit)
  const proof=await collect(sellCi,result)
  assert.equal(proof.status,'finalized-success');assert.equal(proof.governanceRevision,sellPlan.canary.finalRevision);assert.equal(proof.tradingPausedAtCommit,true)
  await sync();assert.equal(decoded('swap','Config',a.swapConfig).paused,true);assert.equal(decoded('launch','Config',a.launchConfig).paused,true)
  assert.equal(decoded('token','Holding',pda(profile.programs.token,'holding',pk(roles.mint).toBuffer(),pk(roles.creator).toBuffer())).amount.toString(),'0')
  note('atomic-sell-index3',result)
 })
 await t.test('historical buy recovery survives later sell governance revisions without resending',async()=>{
  const before=await protectedState(),transactions=executed.size
  assert.notEqual(decoded('swap','Governance',a.swapGovernance).state.revision.toString(),plan.canary.finalRevision)
  const proof=await collect(ci,buyResult)
  assert.equal(proof.status,'finalized-success');assert.equal(proof.governanceRevision,plan.canary.finalRevision)
  assert.equal(proof.tradingPausedAtCommit,true);assert.equal(executed.size,transactions)
  assert.deepEqual(await protectedState(),before)
 })
 await t.test('wire and review deadline limits remain enforced',()=>{
  const stale=structuredClone(sellCi);stale.limits.nowMs=6000
  assert.throws(()=>compileCanaryInclusiveMaxWalletSwapReview(stale),/Stale|lifetime/)
  const oversize=structuredClone(sellPlan.review);oversize.messageBase64=Buffer.alloc(1233).toString('base64')
  assert.throws(()=>inspectHookLabMessage(oversize),/Invalid canonical bytes/)
 })
 await t.test('local test configuration cannot compile a canary under production mode',()=>{
  const original=process.env.NODE_ENV
  try{process.env.NODE_ENV='production';assert.throws(()=>compileCanaryInclusiveMaxWalletSwapReview(sellCi))}
  finally{process.env.NODE_ENV=original}
 })
 console.log('ATOMIC_CANARY_EVIDENCE '+JSON.stringify({...report,lookupAddresses:(Buffer.from(state.lookupTable.dataBase64,'base64').length-56)/32,sourceBoundaries:'ordinary builders and production routes unchanged; no RPC/DB/services'}))
})
