// Entirely synthetic executable bytes and disposable deterministic identities. No RPC or keys from disk.
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { fixture,sha,pk,pda,key } from './selected-hook-preparation.mjs'
import { selectedHookLaunchInventory,openLaunchTableAddresses,launchPreparationRequest } from '../../src/hooklab-max-wallet-launch.mjs'
import { sharedTable } from './hooklab-open-launch.mjs'
import { collectOpenLaunchReview } from '../../src/hooklab-max-wallet-launch-collector.mjs'
import { deriveOpenLaunchPostconditions } from '../../src/hooklab-max-wallet-launch-settlement.mjs'
import {Keypair,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
export function selectedLaunchFixture(){
 const f=fixture(),p=JSON.parse(f.profile.json),root=new URL('../../vendor/',import.meta.url)
 const read=file=>readFileSync(new URL(file,root)),zero=key(0),loader='BPFLoaderUpgradeab1e11111111111111111111111'
 const launch=JSON.parse(read('hooklab-native-candidate/open-36dd07e/bordrless_launch.json'))
 const swap=JSON.parse(read('hooklab-native-candidate/bordrless_swap.json'))
 const token=JSON.parse(read('hooklab-production-candidate/idl/bordrless_token.json'))
 const idls={launch,swap,token},coders=Object.fromEntries(Object.entries(idls).map(([k,v])=>[k,new BorshCoder(v)]))
 const def=(role,t)=>typeof t==='string'?(t==='pubkey'?pk(zero):t==='bool'?false:t==='string'?'':['u64','i64','u128','i128'].includes(t)?new BN(0):0):t.option?null:t.array?Array.from({length:t.array[1]},()=>def(role,t.array[0])):Object.fromEntries(idls[role].types.find(x=>x.name===t.defined.name).type.fields.map(x=>[x.name,def(role,x.type)]))
 const value=(role,name,v)=>({...def(role,{defined:{name}}),...v}),accounts=new Map(f.observations[0].accounts.map(x=>[x.address,structuredClone(x.account)]))
 const put=(address,owner,data,executable=false)=>accounts.set(address,{address,owner,executable,lamports:'10000000000',dataBase64:data.toString('base64')})
 const typed=(role,name,address,v,length)=>{const b=Buffer.alloc(length);Buffer.from(idls[role].accounts.find(x=>x.name===name).discriminator).copy(b);coders[role].types.encode(name,v).copy(b,8);put(address,p.programs[role],b)}
 const elf=Buffer.from([127,69,76,70,8,3,2,1])
 delete p.programs.bridge
 p.stack={id:'synthetic-selected',build:'synthetic-test-only',upgradeAuthority:key(91),kitProgram:'AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm',tokenElfLength:elf.length,open:true}
 for(const role of ['launch','swap','gate','token']){
  const program=p.programs[role],pd=pda(loader,pk(program).toBuffer()),pb=Buffer.alloc(36),db=Buffer.alloc(45+elf.length)
  pb.writeUInt32LE(2);pk(pd).toBuffer().copy(pb,4);db.writeUInt32LE(3);db.writeBigUInt64LE(50n,4);elf.copy(db,45)
  put(program,loader,pb,true);put(pd,loader,db)
  if(role!=='token'){p.elfSha256[role]=sha(elf);f.profile.elfLengths[role]=elf.length}
  else p.dependencyObservation.tokenElfSha256=sha(elf)
 }
 for(const role of ['launch','swap']){const b=Buffer.from(JSON.stringify(idls[role]));f.profile.idls[role]=b.toString('base64');p.idlSha256[role]=sha(b)}
 const L=p.programs.launch,S=p.programs.swap,T=p.programs.token,admin=key(81),treasury=key(82)
 const lc=coders.launch.accounts.decode('Config',Buffer.from(accounts.get(pda(L,'config')).dataBase64,'base64'))
 Object.assign(lc,{admin:pk(admin),treasury:pk(treasury),curve_bps:7500,min_virtual_quote:new BN(100),max_virtual_quote:new BN(1000)})
 const sc=value('swap','Config',{version:1,bump:PublicBump(S,'config'),admin:pk(admin),treasury:pk(treasury),fee_collector:pk(treasury),launch_protocol_share_bps:2500})
 typed('launch','Config',pda(L,'config'),lc,250);typed('swap','Config',pda(S,'config'),sc,189)
 for(const [role,c] of [['launch',lc],['swap',sc]]){
  const program=p.programs[role],econ=Buffer.concat([Buffer.from(`hook-lab/${role}-governed-economics/1\0`),pk(program).toBuffer(),coders[role].types.encode('ConfigArgs',{...c,admin:pk(zero),treasury:pk(zero),paused:false})])
  typed(role,'Governance',pda(program,'governance'),value(role,'Governance',{bump:PublicBump(program,'governance'),state:{genesis:[...pk(p.genesisHash).toBuffer()],program:pk(program),config:pk(pda(program,'config')),roles:{admin:pk(admin),treasury:pk(treasury),upgrade:pk(key(83)),guardian:pk(key(84))},revision:new BN(0),gates:{creation:false,trading:false},config_digest:[...Buffer.from(sha(econ),'hex')],custody_digest:Array(32).fill(0),pending_admin:null}}),348)
 }
 typed('launch','LaunchConfig',f.request.selectedConfig,value('launch','LaunchConfig',{version:1,creator:pk(f.request.creator),label:f.request.label,creator_fee_bps:100,custom_hook:pk(f.hookPin.program),custom_hook_flags:255}),176)
 typed('token','Mint',p.quoteMint,value('token','Mint',{version:1,name:'Synthetic',symbol:'SYN'}),519)
 put(f.request.creator,zero,Buffer.alloc(0));put(treasury,zero,Buffer.alloc(0))
 f.profile.json=JSON.stringify(p);f.profile.expectedSha256=sha(f.profile.json)
 const request={...f.request,schema:'repoing/selected-hook-launch-request/1',name:'Selected',symbol:'SEL',uri:'',virtualQuote:'500'}
 const configBytes=Buffer.from(accounts.get(pda(L,'config')).dataBase64,'base64'),{addresses,inventory}=selectedHookLaunchInventory(f.profile,request,configBytes,{accounts,hookPin:f.hookPin})
 const input={profile:f.profile,hookPin:f.hookPin,request,nativeLaunches:true,preparationEvidence:{schema:'repoing/max-wallet-durable-prepared-state/1',profileSha256:f.profile.expectedSha256,preparationIntentSha256:sha(JSON.stringify(launchPreparationRequest(request))),executionSlot:100,preparedAccountHashes:{selectedConfig:sha(Buffer.from(accounts.get(request.selectedConfig).dataBase64,'base64')),registry:sha(Buffer.from(accounts.get(addresses.registry).dataBase64,'base64'))}},reviewedStateHashes:Object.fromEntries(['launchConfig','swapConfig','launchGovernance','swapGovernance','quoteMint'].map(k=>[k,sha(Buffer.from(accounts.get(k==='quoteMint'?p.quoteMint:addresses[k]).dataBase64,'base64'))])),observations:f.observations.map(o=>({provider:o.provider,genesisHash:o.genesisHash,commitment:o.commitment,slot:o.slot,observedAtMs:o.observedAtMs,accounts:inventory.map(address=>({address,account:accounts.get(address)??null}))})),recentBlockhash:f.recentBlockhash,lookupTable:sharedTable(openLaunchTableAddresses(f.profile,configBytes)),limits:{...f.limits,maxLaunchFeeLamports:'0',maxPoolCreationFeeLamports:'0',maxRentLamports:'2000',maxInstructionDebitLamports:'2000'}}
 input.observations=input.observations.map(o=>structuredClone(o))
 return {input,accounts,addresses,coders,p,configBytes}
}
import {PublicKey} from '@solana/web3.js'
const PublicBump=(program,seed)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],pk(program))[1]

export function selectedLaunchCollectorFixture(){
 const f=selectedLaunchFixture(),{input,accounts,p,addresses:a}=f
 const hashAccount=address=>sha(Buffer.from(accounts.get(address).dataBase64,'base64'))
 const programs=['launch','swap','gate','token'].map(role=>{const address=p.programs[role],programData=pda('BPFLoaderUpgradeab1e11111111111111111111111',pk(address).toBuffer()),b=Buffer.from(accounts.get(programData).dataBase64,'base64');return {role,address,programData,upgradeAuthority:null,deploySlot:50,programDataSha256:sha(b),elfLength:b.length-45,elfSha256:sha(b.subarray(45))}})
 const dossier={schema:'repoing/production-observation/1',genesisHash:p.genesisHash,artifacts:{sourceCommit:p.sourceCommit,profileSha256:input.profile.expectedSha256,sdkSha256:'1'.repeat(64),idlSha256:'2'.repeat(64),provenanceSha256:'3'.repeat(64)},providers:input.profile.providers,minSlot:100,maxSlotLag:5,maxAgeMs:5000,programs,accounts:Object.entries({'launch-config':a.launchConfig,'swap-config':a.swapConfig,'creation-control':a.launchGovernance,'swap-governance':a.swapGovernance,'quote-mint':p.quoteMint}).map(([role,address])=>({role,address,owner:accounts.get(address).owner,executable:false,dataSha256:hashAccount(address)}))}
 const dossierJson=JSON.stringify(dossier),table=input.lookupTable
 accounts.set(table.address,{...table,executable:false,lamports:'10000'});delete accounts.get(table.address).sha256
 const config={schema:'repoing/inclusive-max-wallet-operator-config/1',enabled:true,feeModel:2,approvalReference:'SYNTHETIC TEST ONLY',profileSha256:input.profile.expectedSha256,dossierSha256:sha(dossierJson),providerTrustDomains:input.profile.providers.map(provider=>({provider,trustDomain:provider,origin:`https://${provider}.example.org/`})),economics:{creatorFeeBps:100,authorShareBps:0,lpFeeBps:0,maxCreatorFeeBps:200,protocolFeeBps:0,launchProtocolShareBps:2500,launchFeeLamports:'0',poolCreationFeeLamports:'0'},reviewer:key(81),treasury:key(82),lookupTable:null,launchLookupTable:{address:table.address,sha256:table.sha256},lamportsPerSignature:'5000',selectedHookPin:input.hookPin}
 const connections=input.profile.providers.map(provider=>({provider,connection:{rpcEndpoint:`https://${provider}.example.org/`,async getGenesisHash(){return p.genesisHash},async getMultipleAccountsInfoAndContext(keys){return {context:{slot:100},value:keys.map(k=>{const v=accounts.get(k.toBase58());return v?{owner:pk(v.owner),executable:v.executable,lamports:Number(v.lamports),data:Buffer.from(v.dataBase64,'base64')}:null})}},async getLatestBlockhashAndContext(){return {context:{slot:100},value:{blockhash:input.recentBlockhash.blockhash,lastValidBlockHeight:200}}},async isBlockhashValid(){return {context:{slot:100},value:true}},async getBlockHeight(){return 100},async getFeeForMessage(){return {context:{slot:100},value:10000}}}}))
 return {...f,config,profile:input.profile,dossierJson,connections,request:input.request,limits:input.limits,clock:()=>1000,nativeLaunches:true,preparation:{wallet:input.request.creator,profileSha256:input.profile.expectedSha256,preparationIntentSha256:input.preparationEvidence.preparationIntentSha256,preparedRequest:launchPreparationRequest(input.request),executionSlot:100,preparedAccountHashes:input.preparationEvidence.preparedAccountHashes}}
}
export async function selectedLaunchSettlementFixture({revalidate=false}={}){
 const f=selectedLaunchCollectorFixture(),first=await collectOpenLaunchReview(f),collected=revalidate?await collectOpenLaunchReview({...f,clock:()=>1001,expectedReview:first.plan.review}):first,{review}=collected.plan,settlementContext=collected.settlementContext
 const tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(review.messageBase64,'base64')))
 tx.sign([31,32].map(n=>Keypair.fromSeed(Buffer.alloc(32,n))))
 const signedTransactionBase64=Buffer.from(tx.serialize()).toString('base64'),signature=bs58.encode(tx.signatures[0]),slot=110
 const expected=deriveOpenLaunchPostconditions(settlementContext,{slot,timestamp:1000}),post=new Map(f.accounts)
 for(const a of expected.accounts)post.set(a.address,{...a,lamports:expected.created.includes(a.address)?'100':f.accounts.get(a.address).lamports})
 const keys=review.accounts.map(a=>a.address),idx=k=>keys.indexOf(k),preBalances=keys.map(k=>Number(f.accounts.get(k)?.lamports??0)),postBalances=[...preBalances]
 let rent=0;for(const a of expected.created){postBalances[idx(a)]=100;rent+=100-preBalances[idx(a)]}
 postBalances[idx(f.request.creator)]-=rent+10000
 const event=e=>({programIdIndex:idx(e.program),accounts:[idx(e.program===f.p.programs.swap?f.addresses.swapEventAuthority:f.addresses.eventAuthority)],data:bs58.encode(Buffer.from(e.dataBase64,'base64')),stackHeight:e.program===f.p.programs.swap?3:2})
 const events=expected.events,innerInstructions=[{index:2,instructions:[event(events.find(e=>e.name==='OpenLaunchCreated')),{programIdIndex:idx(f.p.programs.swap),accounts:[],data:bs58.encode(Buffer.from([1])),stackHeight:2},event(events.find(e=>e.name==='PoolCreated')),event(events.find(e=>e.name==='LaunchCreated')),event(events.find(e=>e.name==='NativeLaunchCreated'))]}]
 const loaded=review.accounts.slice(tx.message.staticAccountKeys.length),transaction={slot,transaction:{message:tx.message,signatures:tx.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee:10000,preBalances,postBalances,innerInstructions,loadedAddresses:{writable:loaded.filter(x=>x.writable).map(x=>pk(x.address)),readonly:loaded.filter(x=>!x.writable).map(x=>pk(x.address))}}}
 for(const {connection}of f.connections){connection.getTransaction=async()=>transaction;connection.getBlockSignatures=async()=>({parentSlot:109,blockHeight:110,blockhash:key(61),previousBlockhash:key(62),signatures:[signature]});connection.getMultipleAccountsInfoAndContext=async keys=>({context:{slot:111},value:keys.map(k=>{const a=post.get(k.toBase58());return a?{owner:pk(a.owner),executable:a.executable,lamports:Number(a.lamports),data:Buffer.from(a.dataBase64,'base64')}:null})})}
 return {...f,review,settlementContext,signedTransactionBase64,signature,transaction,post,expected}
}
