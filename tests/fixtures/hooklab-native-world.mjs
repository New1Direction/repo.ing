// A native-SOL Hooks coin in one isolated in-memory SBF bank, on the reviewed native ELFs (HOOKLAB_NATIVE_ELF_DIR):
// the governed native-launches switch sent by the synthetic admin, then the website's native launch review
// (create_launch_custom_v4, quote form 1, through create_pool_v4), so both native flags come from the programs, never from
// a hand-set byte. Every trade test then runs real signed transactions; only the RPC framing around the bank is synthetic.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {AddressLookupTableAccount,Keypair,TransactionMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {compileMaxWalletLaunchReview} from '../../src/hooklab-max-wallet-launch.mjs'
import {NATIVE_ELF} from '../../src/hooklab-native-pins.mjs'
import {canaryCommitment} from '../../src/hooklab-canary-policy.mjs'
import {makeCanaryState,canaryCollectorBindings,localTestEnvironment,isolatedSvm,pk,pda} from './hooklab-canary.mjs'
import {missingArtifactEnv} from './hooklab-generated-artifact.mjs'
import {estimateTrade} from '../../app/lib/hooklab-trade-math.mjs'

const sha=x=>createHash('sha256').update(x).digest()
export const NATIVE_SKIP=process.env.HOOKLAB_CANARY_REQUIRED!=='true'&&missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'],
 'the reviewed native-SOL ELFs, hook-lab e357fdf; HOOKLAB_CANARY_PYTHONPATH must hold solders 0.29.0')
const NAMES={launch:'bordrless_launch',swap:'bordrless_swap',gate:'hook_max_wallet',token:'bordrless_token'}

// The same chain under another operator profile (as a newer reviewed bundle): bindings re-pinned to a changed profile JSON.
export function rebound(bindings,change){
 const hex=x=>createHash('sha256').update(x).digest('hex'),json=JSON.stringify(change(JSON.parse(bindings.profile.json))),profile={...bindings.profile,json,expectedSha256:hex(json)}
 const dossier=JSON.parse(bindings.dossierJson);dossier.artifacts.profileSha256=profile.expectedSha256
 const dossierJson=JSON.stringify(dossier)
 return {config:{...bindings.config,profileSha256:profile.expectedSha256,dossierSha256:hex(dossierJson)},profile,dossierJson}
}

// coin: 'native' (the switch on, then a native launch) or 'bridged' (a bridged launch with the switch still off, as
// today's coins are; switchNativeLaunches() then turns it on).
export async function nativeWorld({capBps=5000,coin='native'}={}){
 const elfDirectory=process.env.HOOKLAB_NATIVE_ELF_DIR
 const saved=Object.fromEntries(Object.keys(localTestEnvironment()).map(k=>[k,process.env[k]]))
 Object.assign(process.env,localTestEnvironment())
 const svm=isolatedSvm()
 const close=()=>{svm.close();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
 const base=JSON.parse(readFileSync(new URL('../../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json',import.meta.url)))
 const pin={...base.elfSha256,launch:NATIVE_ELF.launch.sha256,swap:NATIVE_ELF.swap.sha256,token:base.dependencyObservation.tokenElfSha256}
 const init=await svm.call('init',{scope:'isolated-canary-svm/1',programs:Object.entries(NAMES).map(([role,name])=>({address:base.programs[role],path:`${elfDirectory}/${name}.so`,sha256:pin[role]}))})
 // An ordinary open market (makeCanaryState's native mode: the swap unpaused, no governance trading gate) on a 1 SOL
 // virtual-quote curve, so two capped wallets can finish it. A third synthetic trader with the same SOL.
 const roles=init.roles,state=makeCanaryState({elfDirectory,roles,blockhash:init.blockhash,native:true,capBps,virtualQuote:'1000000000'}),a=state.addresses,P=base.programs
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
 async function switchNativeLaunches(){
  const switched=await send(await compile(roles.admin,[state.instruction('launch','governed_set_native_launches',
   {expected:[...Buffer.from(canaryCommitment(state.bindings.launch,decoded('launch','Governance',a.launchGovernance).state),'hex')],on:true},{authority:roles.admin})]))
  if(switched.error)throw Error(`native switch: ${switched.error}`)
  await sync()
  if(Buffer.from(state.accounts.get(a.launchConfig).dataBase64,'base64')[186]!==1)throw Error('native switch did not land')
 }
 // The website's launch review over the state as it is, sent as is: native (create_launch_custom_v4, quote form 1) once
 // the switch is on, or bridged before it.
 if(coin==='native')await switchNativeLaunches()
 const plan=compileMaxWalletLaunchReview({...state.launchInputNow(),...(coin==='native'?{nativeLaunches:true}:{})}),launched=await send(plan.review.messageBase64)
 if(launched.error)throw Error(`${coin} launch: ${launched.error} ${launched.logs.slice(-6).join(' | ')}`)
 await sync([...state.accounts.keys(),...Object.values(a),roles.mint])

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
 // The minimum received a panel would send for this trade now (its estimate less the slippage), or '1' where the
 // estimate already refuses (those tests expect a refusal before the minimum matters).
 const minimumOut=async(side,amount,trader,slippageBps=300)=>{
  const holding=pda(P.token,'holding',pk(roles.mint).toBuffer(),pk(trader).toBuffer())
  const rows=new Map((await svm.call('get',{addresses:[a.pool,a.launch,holding]})).accounts.map(r=>[r.address,r.account]))
  const decode=(role,type,address)=>state.bindings[role].coder.accounts.decode(type,Buffer.from(rows.get(address).dataBase64,'base64'))
  const p=decode('swap','Pool',a.pool),l=decode('launch','Launch',a.launch),held=rows.get(holding)?.owner===P.token?Buffer.from(rows.get(holding).dataBase64,'base64').readBigUInt64LE(74):0n
  const market={graduated:l.status===1,graduationQuote:l.graduation_quote.toString(),creatorFeeBps:100,capBps,initialSupply:'1000000000000000',
   pool:{baseReserve:p.base_reserve.toString(),quoteReserve:p.quote_reserve.toString(),virtualBase:p.virtual_base.toString(),virtualQuote:p.virtual_quote.toString(),protocolFeesQuote:p.protocol_fees_quote.toString()}}
  const e=estimateTrade(market,{side,amount:BigInt(amount),coinBalance:held,slippageBps})
  return e.error?'1':String(e.minAmountOut)
 }
 return {svm,state,roles,addresses:a,programs:P,profile:base,send,submit,sync,expire,blockhash,compile,decoded,executed,connections,bindings,lamports,close,launched,lookup,minimumOut,switchNativeLaunches,
  holdingOf:(mint,owner)=>pda(P.token,'holding',pk(mint).toBuffer(),pk(owner).toBuffer()),
  // The runner's deterministic synthetic test-domain key for a role (tests/fixtures/hooklab-canary-svm.py), to sign as a wallet.
  walletKey:role=>Keypair.fromSeed(sha(`repo.ing atomic canary isolated SVM tests v1 ${role}`))}
}
