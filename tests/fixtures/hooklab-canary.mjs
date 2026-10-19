// Fresh synthetic setup, never historical fixture payloads or a production custody source.
import {readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {BorshCoder} from '@anchor-lang/core'
import BN from 'bn.js'
import {PublicKey,TransactionInstruction} from '@solana/web3.js'
import {maxWalletLaunchInventory} from '../../src/hooklab-max-wallet-launch.mjs'
import {inclusiveMaxWalletSwapInventory} from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
import {NATIVE_ELF,NATIVE_IDL_SHA256} from '../../src/hooklab-native-pins.mjs'
export const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x),zero=PublicKey.default.toBase58()
export const loader='BPFLoaderUpgradeab1e11111111111111111111111'
export const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),pk(program))[0].toBase58()
const bump=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),pk(program))[1]
const bn=x=>new BN(String(x))
export const syntheticGenesis=pk(createHash('sha256').update('isolated in-memory atomic canary genesis v1').digest()).toBase58()
export function localTestEnvironment(){return {NODE_ENV:'development',HOOK_LOCAL_ACCEPTANCE:'true',HOOK_LOCAL_ACCEPTANCE_GENESIS:syntheticGenesis,
 HOOK_WALLET_IDENTITY_ORIGIN:'https://127.0.0.1:19443',HOOK_WALLET_IDENTITY_DATABASE_URL:'postgresql://localhost/hooks_local_canary_svm',
 HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY:'https://127.0.0.1:19444',HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY:'https://127.0.0.1:19445'}}
// native: the reviewed native-SOL launch and swap builds (hook-lab e357fdf IDLs and ELFs, HOOKLAB_NATIVE_ELF_DIR) under an
// ordinary open market (swap unpaused, no governance gate) with the owner's USD-priced virtual-quote bounds; the launch
// Config switch starts off, as on mainnet before the governed change. prepared: false leaves out the mint's prepared policy,
// registry and selected config (launchInput is then null), for a test that runs the real preparation first.
export function makeCanaryState({elfDirectory,roles,blockhash,native=false,prepared=true}){
 const base=new URL('../../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/',import.meta.url),nativeBase=new URL('../../vendor/hooklab-native-candidate/',import.meta.url)
 const original=JSON.parse(readFileSync(new URL('offline-builder-profile.json',base))),idlNames={launch:'bordrless_launch',swap:'bordrless_swap',gate:'hook_max_wallet',token:'bordrless_token'}
 const idlUrl=role=>role==='token'?new URL('../../vendor/hooklab-production-candidate/idl/bordrless_token.json',import.meta.url):new URL(`${idlNames[role]}.json`,native&&NATIVE_ELF[role]?nativeBase:base)
 const idls=Object.fromEntries(Object.keys(idlNames).map(role=>[role,JSON.parse(readFileSync(idlUrl(role)))]))
 const bindings=Object.fromEntries(Object.entries(idls).map(([role,idl])=>[role,{idl,coder:new BorshCoder(idl)}]))
 const elfPin=role=>role==='token'?original.dependencyObservation.tokenElfSha256:native&&NATIVE_ELF[role]?NATIVE_ELF[role].sha256:original.elfSha256[role]
 const artifacts=Object.entries(idlNames).map(([role,name])=>({role,address:original.programs[role],path:`${elfDirectory}/${name}.so`,sha256:elfPin(role)}))
 const elfs=Object.fromEntries(artifacts.map(a=>{const bytes=readFileSync(a.path);if(sha(bytes)!==a.sha256)throw Error('Pinned canary ELF differs');return [a.role,bytes]}))
 const profile={...original,schema:'hook-lab/local-inclusive-max-wallet-builder-profile/1',profileId:native?'fresh-isolated-native-launch':'fresh-isolated-atomic-canary',genesisHash:syntheticGenesis,
  ...(native?{idlSha256:{...original.idlSha256,...NATIVE_IDL_SHA256},elfSha256:{...original.elfSha256,launch:NATIVE_ELF.launch.sha256,swap:NATIVE_ELF.swap.sha256}}:{})}
 const json=JSON.stringify(profile),envelope={json,expectedSha256:sha(json),idls:Object.fromEntries(['launch','swap','gate'].map(role=>[role,Buffer.from(JSON.stringify(idls[role])).toString('base64')])),
  elfLengths:Object.fromEntries(['launch','swap','gate'].map(role=>[role,elfs[role].length])),providers:['isolated-a','isolated-b']}
 // Preserve exact public IDL byte pins, not JSON reserialization.
 for(const role of ['launch','swap','gate'])envelope.idls[role]=readFileSync(idlUrl(role)).toString('base64')
 const {launch:L,swap:S,gate:G,token:T}=profile.programs
 const defaults=(role,type)=>{
  if(typeof type==='string')return type==='pubkey'?pk(zero):type==='bool'?false:type==='string'?'':['u64','u128','i64','i128'].includes(type)?bn(0):0
  if(type.option)return null
  if(type.array)return Array.from({length:type.array[1]},()=>defaults(role,type.array[0]))
  if(type.defined)return Object.fromEntries(idls[role].types.find(t=>t.name===type.defined.name).type.fields.map(f=>[f.name,defaults(role,f.type)]))
  throw Error('Unsupported synthetic codec')
 }
 const value=(role,type,overrides)=>({...defaults(role,{defined:{name:type}}),...overrides})
 const bytes=(role,type,data,length)=>{const body=bindings[role].coder.types.encode(type,data),disc=idls[role].accounts.find(a=>a.name===type).discriminator,out=Buffer.alloc(length);if(body.length+8>length)throw Error('Synthetic allocation too short');Buffer.from(disc).copy(out);body.copy(out,8);return out}
 const accounts=new Map(),put=(address,owner,data=Buffer.alloc(0),lamports='10000000000',executable=false)=>accounts.set(address,{address,owner,dataBase64:data.toString('base64'),lamports,executable})
 const typed=(role,type,address,data,length)=>put(address,profile.programs[role],bytes(role,type,data,length))
 for(const role of ['creator','admin','upgrade','guardian','treasury','outsider'])put(roles[role],zero)
 for(const {role,address} of artifacts){const pd=pda(loader,pk(address).toBuffer()),header=Buffer.alloc(45);header.writeUInt32LE(3);header.writeBigUInt64LE(1n,4)
  if(role!=='gate'){header[12]=1;pk(roles.upgrade).toBuffer().copy(header,13)}
  put(pd,loader,Buffer.concat([header,elfs[role]]));const program=Buffer.alloc(36);program.writeUInt32LE(2);pk(pd).toBuffer().copy(program,4);put(address,loader,program,'10000000000',true)
 }
 const ruleBounds=value('launch','RuleBounds',{max_rules_fee_bps:100,min_max_wallet_bps:1,max_max_wallet_bps:9999})
 const bounds=native?['5625000000','112500000000']:['1000000000','1000000000']
 const lc=value('launch','Config',{version:1,bump:bump(L,'config'),admin:pk(roles.admin),treasury:pk(roles.treasury),quote_mint:pk(profile.quoteMint),
  max_creator_fee_bps:100,curve_bps:7500,supply:bn('1000000000000000'),decimals:6,min_virtual_quote:bn(bounds[0]),max_virtual_quote:bn(bounds[1]),paused:false,rule_bounds:ruleBounds})
 const sc=value('swap','Config',{version:1,bump:bump(S,'config'),admin:pk(roles.admin),treasury:pk(roles.treasury),fee_collector:pk(roles.treasury),paused:!native,launch_protocol_share_bps:2500})
 typed('launch','Config',pda(L,'config'),lc,250);typed('swap','Config',pda(S,'config'),sc,189)
 for(const [role,program,config]of [['launch',L,lc],['swap',S,sc]]){
  const economics=Buffer.concat([Buffer.from(`hook-lab/${role}-governed-economics/1\0`),pk(program).toBuffer(),bindings[role].coder.types.encode('ConfigArgs',{...config,admin:pk(zero),treasury:pk(zero),paused:false})])
  typed(role,'Governance',pda(program,'governance'),{bump:bump(program,'governance'),state:{genesis:[...pk(syntheticGenesis).toBuffer()],program:pk(program),config:pk(pda(program,'config')),
   roles:Object.fromEntries(['admin','upgrade','guardian','treasury'].map(k=>[k,pk(roles[k])])),revision:bn(0),gates:{creation:false,trading:role==='swap'&&!native},config_digest:[...Buffer.from(sha(economics),'hex')],custody_digest:Array(32).fill(7),pending_admin:null}},348)
 }
 typed('launch','CreatorAuthorization',pda(L,'creator-authorization',pk(roles.creator).toBuffer()),value('launch','CreatorAuthorization',{creator:pk(roles.creator),enabled:true,expires_at_slot:bn(1000),max_launches:bn(1),revision:bn(1)}),73)
 if(prepared)typed('launch','LaunchConfig',roles.config,value('launch','LaunchConfig',{version:1,creator:pk(roles.creator),label:'private-canary',creator_fee_bps:100,custom_hook:pk(G),custom_hook_flags:1}),176)
 if(prepared)typed('gate','PolicyV2',pda(G,'policy-v2',pk(roles.mint).toBuffer()),value('gate','PolicyV2',{version:2,mint:pk(roles.mint),initial_supply:lc.supply,cap_bps:200,quote_mint:pk(profile.quoteMint),fee_model:2,protocol_share_bps:2500,creator_fee_bps:100}),90)
 if(prepared)put(pda(G,'bordrless-hook-accounts',pk(roles.mint).toBuffer()),G,Buffer.concat([Buffer.from('02daf6662c38c0cd01020000000000','hex'),pk(pda(G,'policy-v2',pk(roles.mint).toBuffer())).toBuffer(),Buffer.from([0,0]),pk(pda(L,'launch',pk(roles.mint).toBuffer())).toBuffer()]))
 typed('token','Mint',profile.quoteMint,value('token','Mint',{version:1,decimals:9,supply:bn('1000000000000'),max_supply:bn('1000000000000'),name:'Synthetic quote',symbol:'TEST',creator:pk(roles.creator)}),519)
 const prep={schema:'repoing/inclusive-max-wallet-preparation-request/1',policyKind:'max-wallet',policyVersion:2,creator:roles.creator,feePayer:roles.creator,mint:roles.mint,selectedConfig:roles.config,capBps:200,label:'private-canary',creatorFeeBps:100,rules:'none',hookFlags:1,feeModel:2,protocolShareBps:2500}
 const request={...prep,schema:'repoing/inclusive-max-wallet-launch-request/1',reviewer:roles.admin,name:'Private canary',symbol:'CANARY',uri:'',virtualQuote:native?'53251917070':'1000000000'}
 const derived=maxWalletLaunchInventory(envelope,request,Buffer.from(accounts.get(pda(L,'config')).dataBase64,'base64')),a=derived.addresses
 const table=Buffer.alloc(56+32*derived.inventory.length);table.writeUInt32LE(1);table.writeBigUInt64LE(0xffffffffffffffffn,4);table.writeBigUInt64LE(99n,12);table[21]=1;pk(roles.admin).toBuffer().copy(table,22)
 derived.inventory.forEach((address,i)=>pk(address).toBuffer().copy(table,56+i*32))
 const lookupTable={address:roles.table,owner:'AddressLookupTab1e1111111111111111111111111',dataBase64:table.toString('base64'),sha256:sha(table)}
 put(roles.table,lookupTable.owner,table)
 const observe=inventory=>envelope.providers.map(provider=>({provider,genesisHash:syntheticGenesis,commitment:'finalized',slot:100,observedAtMs:1000,accounts:inventory.map(address=>({address,account:accounts.get(address)??null}))}))
 const block=(fee,hash=blockhash)=>({blockhash:hash,genesisHash:syntheticGenesis,providers:envelope.providers,observedAtMs:1000,currentBlockHeight:100,blockhashValid:true,lastValidBlockHeight:250,observedSlot:100,networkFeeLamports:String(fee),lamportsPerSignature:'5000'})
 const limits={nowMs:1000,maxAgeMs:5000,maxSlotLag:5,validUntilSlot:196,reviewExpiresAtMs:6000,maxNetworkFeeLamports:'15000',maxTotalDebitLamports:'200015000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}
 const accountHash=address=>sha(Buffer.from(accounts.get(address).dataBase64,'base64'))
 // launchInputNow(): the same input over the accounts as they are now (after a sync from the bank).
 const launchInputNow=()=>({profile:envelope,request,preparationEvidence:{schema:'repoing/max-wallet-durable-prepared-state/1',profileSha256:envelope.expectedSha256,preparationIntentSha256:sha(JSON.stringify(prep)),executionSlot:100,preparedAccountHashes:{policy:accountHash(a.policy),registry:accountHash(a.registry),selectedConfig:accountHash(roles.config)}},
  reviewedStateHashes:Object.fromEntries(['launchConfig','swapConfig','launchGovernance','swapGovernance','authorization','quoteMint'].map(k=>[k,accountHash(k==='quoteMint'?profile.quoteMint:a[k])])),observations:observe(derived.inventory),recentBlockhash:block(15000),lookupTable,
  limits:{...limits,maxLaunchFeeLamports:'0',maxPoolCreationFeeLamports:'0',maxRentLamports:'200000000',maxInstructionDebitLamports:'200000000'}})
 const launchInput=prepared?launchInputNow():null
 function tradeInput(side,amountIn='1000200',hash=blockhash){const r={schema:'repoing/inclusive-max-wallet-swap-request/1',policyKind:'max-wallet',policyVersion:2,creatorFeeBps:100,feeModel:2,protocolShareBps:2500,capBps:200,
  side,trader:roles.creator,recipient:roles.creator,feePayer:roles.creator,mint:roles.mint,selectedConfig:roles.config,amountIn,minAmountOut:'1',maxInput:amountIn,maxPriceImpactBps:1000}
  return {profile:envelope,request:r,provenance:'server-collected-finalized-state-not-execution-authorization',observations:observe(inclusiveMaxWalletSwapInventory(profile,r)),recentBlockhash:block(10000,hash),lookupTable,limits:{...limits,maxNetworkFeeLamports:'10000',maxTotalDebitLamports:'10000'}}}
 function holding(mint,owner,amount){const address=pda(T,'holding',pk(mint).toBuffer(),pk(owner).toBuffer());typed('token','Holding',address,value('token','Holding',{version:1,bump:bump(T,'holding',pk(mint).toBuffer(),pk(owner).toBuffer()),mint:pk(mint),owner:pk(owner),amount:bn(amount)}),204);return address}
 function instruction(role,name,args,values={}){const program=profile.programs[role],def=idls[role].instructions.find(ix=>ix.name===name),m={program,system_program:zero,config:pda(program,'config'),governance:pda(program,'governance'),event_authority:pda(program,'__event_authority'),...values}
  return new TransactionInstruction({programId:pk(program),data:bindings[role].coder.instruction.encode(name,args),keys:def.accounts.map(k=>({pubkey:pk(m[k.name]??k.address),isSigner:!!k.signer,isWritable:!!k.writable}))})}
 return {accounts,artifacts,profile:envelope,bindings,request,preparationRequest:prep,inventory:derived.inventory,addresses:a,launchInput,launchInputNow,tradeInput,holding,instruction,roles,lookupTable,accountHash}
}

// Test-only operator envelope. These adapters do not attest production finality or custody.
// governance: pin the two governance accounts as the production bundle does ('creation-control' is the launch governance,
// plus 'swap-governance'), which the launch collector requires; the default keeps the canary's authorization pin.
export function canaryCollectorBindings(state,{governance=false}={}){
 const p=JSON.parse(state.profile.json),e=localTestEnvironment()
 const programs=state.artifacts.map(artifact=>{
  const programData=pda(loader,pk(artifact.address).toBuffer()),bytes=Buffer.from(state.accounts.get(programData).dataBase64,'base64')
  return {role:artifact.role,address:artifact.address,programData,upgradeAuthority:artifact.role==='gate'?null:state.roles.upgrade,
   deploySlot:1,programDataSha256:sha(bytes),elfLength:bytes.length-45,elfSha256:artifact.sha256}
 })
 const dossier={schema:'repoing/local-validator-observation/1',genesisHash:syntheticGenesis,topology:'single-local-validator-two-proxies',
  artifacts:{sourceCommit:p.sourceCommit,profileSha256:state.profile.expectedSha256,
   sdkSha256:sha(readFileSync(new URL('../../src/hooklab-inclusive-max-wallet-swap.mjs',import.meta.url))),
   idlSha256:sha(Buffer.concat(Object.values(state.profile.idls).map(v=>Buffer.from(v,'base64')))),
   provenanceSha256:sha(JSON.stringify(state.artifacts.map(({role,sha256})=>({role,sha256}))))},
  providers:state.profile.providers,minSlot:100,maxSlotLag:5,maxAgeMs:5000,programs,
  accounts:Object.entries({'launch-config':state.addresses.launchConfig,'swap-config':state.addresses.swapConfig,
   'quote-mint':p.quoteMint,...(governance?{'creation-control':state.addresses.launchGovernance,'swap-governance':state.addresses.swapGovernance}:{'creation-control':state.addresses.authorization})}).map(([role,address])=>{
    const account=state.accounts.get(address);return {role,address,owner:account.owner,executable:account.executable,dataSha256:state.accountHash(address)}
   })}
 const dossierJson=JSON.stringify(dossier),origins=[e.HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY,e.HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY]
 const config={schema:'repoing/inclusive-max-wallet-operator-config/1',feeModel:2,enabled:true,
  approvalReference:'synthetic isolated SVM test only; no production approval',profileSha256:state.profile.expectedSha256,dossierSha256:sha(dossierJson),
  providerTrustDomains:state.profile.providers.map((provider,i)=>({provider,trustDomain:'one-isolated-test-bank',origin:origins[i]})),
  economics:{creatorFeeBps:100,authorShareBps:0,lpFeeBps:0,maxCreatorFeeBps:100,protocolFeeBps:0,launchProtocolShareBps:2500,launchFeeLamports:'0',poolCreationFeeLamports:'0'},
  reviewer:state.roles.admin,treasury:state.roles.treasury,lookupTable:{address:state.lookupTable.address,sha256:state.lookupTable.sha256},lamportsPerSignature:'5000'}
 return {config,profile:state.profile,dossierJson}
}

// One isolated in-memory SBF bank (LiteSVM via solders), driven line by line over stdio.
export function isolatedSvm(){
 const child=spawn(process.env.HOOKLAB_CANARY_PYTHON??'python3',['-u',fileURLToPath(new URL('./hooklab-canary-svm.py',import.meta.url))],{
  env:{PATH:process.env.PATH,PYTHONPATH:process.env.HOOKLAB_CANARY_PYTHONPATH??'',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']})
 const pending=[];let stderr=''
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000)})
 createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(!p)return;try{const value=JSON.parse(line);if(value.runnerError)p.reject(Error(`${value.runnerError}: ${value.message}`));else p.resolve(value)}catch(e){p.reject(e)}})
 child.on('error',e=>{while(pending.length)pending.shift().reject(e)})
 child.on('exit',code=>{while(pending.length)pending.shift().reject(Error(`Isolated SVM exited ${code}: ${stderr}`))})
 return {call:(op,fields={})=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({op,...fields})+'\n')}),close:()=>child.stdin.end()}
}
