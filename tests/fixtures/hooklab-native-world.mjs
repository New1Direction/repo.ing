// A native-SOL Hooks coin in one isolated in-memory SBF bank, on the reviewed native ELFs (HOOKLAB_NATIVE_ELF_DIR):
// the governed native-launches switch sent by the synthetic admin, then a real create_launch_custom_v4 (quote form 1,
// through create_pool_v4), so both native flags come from the programs, never from a hand-set byte. Every trade
// test then runs real signed transactions; only the RPC framing around the bank is synthetic.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {AddressLookupTableAccount,Keypair,TransactionMessage,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {compileMaxWalletLaunchReview} from '../../src/hooklab-max-wallet-launch.mjs'
import {NATIVE_ELF} from '../../src/hooklab-native-pins.mjs'
import {canaryCommitment} from '../../src/hooklab-canary-policy.mjs'
import {makeCanaryState,canaryCollectorBindings,localTestEnvironment,isolatedSvm,pk,pda} from './hooklab-canary.mjs'
import {missingArtifactEnv} from './hooklab-generated-artifact.mjs'

const sha=x=>createHash('sha256').update(x).digest()
export const NATIVE_SKIP=process.env.HOOKLAB_CANARY_REQUIRED!=='true'&&missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'],
 'the reviewed native-SOL ELFs, hook-lab e357fdf; HOOKLAB_CANARY_PYTHONPATH must hold solders 0.29.0')
const NAMES={launch:'bordrless_launch',swap:'bordrless_swap',gate:'hook_max_wallet',token:'bordrless_token'}
// The quote form rides on the reviewed v3 hashes (hook-lab guard.rs config_hash_v4): sha(domain || v3 || form).
const v4=(domain,v3,form)=>[...sha(Buffer.concat([Buffer.from(domain),Buffer.from(v3),Buffer.from([form])]))]

// The same chain under another operator profile (as a newer reviewed bundle): bindings re-pinned to a changed profile JSON.
export function rebound(bindings,change){
 const hex=x=>createHash('sha256').update(x).digest('hex'),json=JSON.stringify(change(JSON.parse(bindings.profile.json))),profile={...bindings.profile,json,expectedSha256:hex(json)}
 const dossier=JSON.parse(bindings.dossierJson);dossier.artifacts.profileSha256=profile.expectedSha256
 const dossierJson=JSON.stringify(dossier)
 return {config:{...bindings.config,profileSha256:profile.expectedSha256,dossierSha256:hex(dossierJson)},profile,dossierJson}
}

export async function nativeWorld({capBps=5000}={}){
 const elfDirectory=process.env.HOOKLAB_NATIVE_ELF_DIR
 const saved=Object.fromEntries(Object.keys(localTestEnvironment()).map(k=>[k,process.env[k]]))
 Object.assign(process.env,localTestEnvironment())
 const svm=isolatedSvm()
 const close=()=>{svm.close();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
 const base=JSON.parse(readFileSync(new URL('../../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json',import.meta.url)))
 const pin={...base.elfSha256,launch:NATIVE_ELF.launch.sha256,swap:NATIVE_ELF.swap.sha256,token:base.dependencyObservation.tokenElfSha256}
 const init=await svm.call('init',{scope:'isolated-canary-svm/1',programs:Object.entries(NAMES).map(([role,name])=>({address:base.programs[role],path:`${elfDirectory}/${name}.so`,sha256:pin[role]}))})
 const roles=init.roles,state=makeCanaryState({elfDirectory,roles,blockhash:init.blockhash,native:true,capBps}),a=state.addresses,P=base.programs
 // Ordinary trading: the swap unpaused, no governance trading gate. A third synthetic trader with the same SOL.
 const edit=(role,type,address,change)=>{const row=state.accounts.get(address),bytes=Buffer.from(row.dataBase64,'base64'),value=state.bindings[role].coder.accounts.decode(type,bytes);change(value)
  const out=Buffer.alloc(bytes.length);bytes.copy(out,0,0,8);state.bindings[role].coder.types.encode(type,value).copy(out,8);state.accounts.set(address,{...row,dataBase64:out.toString('base64')})}
 edit('swap','Config',a.swapConfig,v=>{v.paused=false});edit('swap','Governance',a.swapGovernance,v=>{v.state.gates.trading=false})
 state.accounts.set(roles.buyer,{...state.accounts.get(roles.outsider),address:roles.buyer})
 await svm.call('set',{accounts:[...state.accounts].map(([address,account])=>({address,account})).sort((x,y)=>Number(x.account.executable)-Number(y.account.executable))})
 const executed=new Map(),lookup=new AddressLookupTableAccount({key:pk(state.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(state.lookupTable.dataBase64,'base64'))})
 const send=async messageBase64=>{const result=await svm.call('send',{messageBase64});if(result.historyPresent)executed.set(result.signature,result);return result}
 // A transaction the wallet signed (through the signing lifecycle), sent exactly as given.
 const submit=async wireBase64=>{const result=await svm.call('submit',{wireBase64});if(result.historyPresent)executed.set(result.signature,result);return result}
 const sync=async(addresses=[...state.accounts.keys()])=>{for(const row of (await svm.call('get',{addresses})).accounts){if(row.account)state.accounts.set(row.address,row.account);else state.accounts.delete(row.address)}}
 const blockhash=async()=>(await svm.call('get',{addresses:[]})).blockhash
 const expire=async()=>(await svm.call('expire')).blockhash
 const compile=async(payer,instructions)=>Buffer.from(new TransactionMessage({payerKey:pk(payer),recentBlockhash:await blockhash(),instructions}).compileToV0Message([lookup]).serialize()).toString('base64')
 const decoded=(role,type,address)=>state.bindings[role].coder.accounts.decode(type,Buffer.from(state.accounts.get(address).dataBase64,'base64'))

 // The governed switch, as the owner would send it: admin-signed against the launch governance commitment.
 const switched=await send(await compile(roles.admin,[state.instruction('launch','governed_set_native_launches',
  {expected:[...Buffer.from(canaryCommitment(state.bindings.launch,decoded('launch','Governance',a.launchGovernance).state),'hex')],on:true},{authority:roles.admin})]))
 if(switched.error)throw Error(`native switch: ${switched.error}`)
 await sync()
 if(Buffer.from(state.accounts.get(a.launchConfig).dataBase64,'base64')[186]!==1)throw Error('native switch did not land')

 // The website's v3 launch review (W2 owns the native one), re-encoded as create_launch_custom_v4 with quote form 1.
 // The v3 compiler refuses a config with the switch byte set, so it reads that one byte as zero; the programs check it.
 const observed=new Map(state.accounts),configBytes=Buffer.from(observed.get(a.launchConfig).dataBase64,'base64');configBytes[186]=0
 observed.set(a.launchConfig,{...observed.get(a.launchConfig),dataBase64:configBytes.toString('base64')})
 const hash=address=>createHash('sha256').update(Buffer.from(observed.get(address).dataBase64,'base64')).digest('hex')
 const li=state.launchInput,launchInput={...li,recentBlockhash:{...li.recentBlockhash,blockhash:await blockhash()},
  reviewedStateHashes:Object.fromEntries(Object.keys(li.reviewedStateHashes).map(k=>[k,hash(k==='quoteMint'?base.quoteMint:a[k])])),
  observations:li.observations.map(o=>({...o,accounts:o.accounts.map(({address})=>({address,account:observed.get(address)??null}))}))}
 const v3=compileMaxWalletLaunchReview(launchInput),message=VersionedMessage.deserialize(Buffer.from(v3.review.messageBase64,'base64'))
 const instructions=TransactionMessage.decompile(message,{addressLookupTableAccounts:[lookup]}).instructions,coder=state.bindings.launch.coder
 const at=instructions.findIndex(ix=>ix.programId.toBase58()===P.launch),data=coder.instruction.decode(instructions[at].data).data
 instructions[at].data=coder.instruction.encode('create_launch_custom_v4',{...data,quote_form:1,guard:{...data.guard,
  expected_launch_economics_hash:v4('hook-lab:create-launch-economics:v4',data.guard.expected_launch_economics_hash,1),
  expected_pool_economics_hash:v4('hook-lab:create-pool-economics:v4',data.guard.expected_pool_economics_hash,1)}})
 const launched=await send(Buffer.from(new TransactionMessage({payerKey:message.staticAccountKeys[0],recentBlockhash:message.recentBlockhash,instructions}).compileToV0Message([lookup]).serialize()).toString('base64'))
 if(launched.error)throw Error(`native launch: ${launched.error} ${launched.logs.slice(-6).join(' | ')}`)
 await sync([...state.accounts.keys(),...Object.values(a)])

 // RPC framing around the bank: fee and slot answers are fixed, every account, simulation and receipt is the bank's.
 const transport=(alter=()=>{})=>({getGenesisHash:async()=>JSON.parse(state.profile.json).genesisHash,getSlot:async()=>100,getBlockHeight:async()=>100,
  getMultipleAccountsInfoAndContext:async keys=>{const s=await svm.call('get',{addresses:keys.map(k=>k.toBase58())})
   return {context:{slot:s.slot},value:s.accounts.map(({account:v})=>v?{owner:pk(v.owner),executable:v.executable,lamports:Number(v.lamports),data:Buffer.from(v.dataBase64,'base64')}:null)}},
  // The bank's blockhash belongs to the finalized block at slot 100, height 100, so it is valid through height 250.
  getLatestBlockhashAndContext:async()=>({context:{slot:100},value:{blockhash:await blockhash(),lastValidBlockHeight:250}}),
  getBlock:async slot=>slot===100?{blockhash:await blockhash(),previousBlockhash:roles.config,parentSlot:99,blockHeight:100,blockTime:null}:null,
  isBlockhashValid:async()=>({context:{slot:100},value:true}),getFeeForMessage:async m=>({context:{slot:100},value:5000*m.header.numRequiredSignatures}),
  simulateTransaction:async(tx,config)=>{const r=await svm.call('simulate',{messageBase64:Buffer.from(tx.message.serialize()).toString('base64'),addresses:config?.accounts?.addresses??[]})
   return {context:{slot:100},value:{err:r.error,logs:r.logs,unitsConsumed:r.units,accounts:r.accounts?.map(v=>v&&{owner:v.owner,lamports:Number(v.lamports),executable:false,rentEpoch:0,data:[v.dataBase64,'base64']})??null}}},
  getTransaction:async signature=>{const r=executed.get(signature);if(!r)return null;const signed=VersionedTransaction.deserialize(Buffer.from(r.wireBase64,'base64'))
   const tx={slot:r.slot,transaction:{message:signed.message,signatures:signed.signatures.map(s=>bs58.encode(s))},meta:{err:r.error,fee:r.fee,preBalances:[...r.preBalances],postBalances:[...r.postBalances],
    loadedAddresses:Object.fromEntries(Object.entries(r.loadedAddresses).map(([k,v])=>[k,v.map(pk)])),logMessages:[...r.logs],
    innerInstructions:r.innerInstructions.map(g=>({index:g.index,instructions:g.instructions.map(({dataBase64,...ix})=>({...ix,accounts:[...ix.accounts],data:bs58.encode(Buffer.from(dataBase64,'base64'))}))}))}}
   alter(tx);return tx},
  getBlockSignatures:async()=>({blockhash:roles.table,previousBlockhash:roles.config,parentSlot:99,blockHeight:100,signatures:[...executed.keys()]})})
 const e=localTestEnvironment(),bindings=canaryCollectorBindings(state)
 const connections=(alter)=>state.profile.providers.map((provider,i)=>({provider,connection:{rpcEndpoint:[e.HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY,e.HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY][i],...transport(alter)}}))
 const lamports=async addresses=>Object.fromEntries((await svm.call('get',{addresses})).accounts.map(r=>[r.address,BigInt(r.account?.lamports??0)]))
 return {svm,state,roles,addresses:a,programs:P,profile:base,send,submit,sync,expire,blockhash,compile,decoded,executed,connections,bindings,lamports,close,launched,lookup,
  holdingOf:(mint,owner)=>pda(P.token,'holding',pk(mint).toBuffer(),pk(owner).toBuffer()),
  // The runner's deterministic synthetic test-domain key for a role (tests/fixtures/hooklab-canary-svm.py), to sign as a wallet.
  walletKey:role=>Keypair.fromSeed(sha(`repo.ing atomic canary isolated SVM tests v1 ${role}`))}
}
