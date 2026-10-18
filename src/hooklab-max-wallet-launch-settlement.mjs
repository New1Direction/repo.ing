// Read-only exact-wire launch reconciliation. Current state is conservative
// initial-postcondition evidence, never historical replay or retry permission.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {BorshCoder} from '@anchor-lang/core'
import BN from 'bn.js'
import bs58 from 'bs58'
import {PublicKey,VersionedTransaction} from '@solana/web3.js'
import {encodeHookAccountList} from '@repo-ing/hooklab-production-candidate'
import {compileMaxWalletLaunchReview} from './hooklab-max-wallet-launch.mjs'
import {productionAccountBindingMatches} from './hooklab-production-observer.mjs'
import {validateMaxWalletOperatorBindings} from './hooklab-max-wallet-launch-collector.mjs'
import {inspectHookLabMessage,verifyHookLabSignedMessage} from './hooklab-message-boundary.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x),bn=x=>new BN(String(x)),key=x=>x.toBase58()
const check=v=>{if(!v)throw Error('Launch settlement evidence differs')}
const read=async work=>{let timer;try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Read unavailable')),5000)})])}finally{clearTimeout(timer)}}
const int=x=>{check(Number.isSafeInteger(x)&&x>=0);return x}
const tag=Buffer.from('e445a52e51cb9a1d','hex'),zero='11111111111111111111111111111111',kit='AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'
const derive=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(x=>typeof x==='string'?Buffer.from(x):x),pk(program))
const pda=(program,...seeds)=>key(derive(program,...seeds)[0]),bump=(program,...seeds)=>derive(program,...seeds)[1]
const tokenBytes=readFileSync(`${process.cwd()}/vendor/hooklab-production-candidate/idl/bordrless_token.json`)
check(sha(tokenBytes)==='93aaa54d2e0c22e444793ac84387c357d73b745d482becada32d7d6e23d2c506')
const tokenIdl=JSON.parse(tokenBytes)
const raw=x=>{const b=Buffer.from(x,'base64');check(b.toString('base64')===x);return b}
const normalize=x=>BN.isBN(x)?x.toString():x instanceof PublicKey?key(x):Array.isArray(x)?x.map(normalize):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,normalize(v)])):x
function binding(idl){return {idl,coder:new BorshCoder(idl)}}
function zeroType(b,t){
 if(typeof t==='string'){if(t==='pubkey')return pk(zero);if(t==='bool')return false;if(t==='string')return '';return ['u64','i64','u128','i128'].includes(t)?bn(0):0}
 if(t.option)return null;if(t.array)return Array.from({length:t.array[1]},()=>zeroType(b,t.array[0]))
 if(t.defined)return zeroStruct(b,t.defined.name);throw Error('Unsupported account layout')
}
function zeroStruct(b,name){return Object.fromEntries(b.idl.types.find(t=>t.name===name).type.fields.map(f=>[f.name,zeroType(b,f.type)]))}
function size(b,t,field){
 if(typeof t==='string'){if(t==='string')return 4+({name:32,symbol:10,uri:200}[field]??(()=>{throw Error('Unknown bounded string')})());return {u8:1,i8:1,bool:1,u16:2,i16:2,u32:4,i32:4,u64:8,i64:8,u128:16,i128:16,pubkey:32}[t]}
 if(t.option)return 1+size(b,t.option);if(t.array)return size(b,t.array[0])*t.array[1]
 return b.idl.types.find(x=>x.name===t.defined.name).type.fields.reduce((n,f)=>n+size(b,f.type,f.name),0)
}
function accountBytes(b,name,value){const bytes=Buffer.alloc(8+size(b,{defined:{name}}));Buffer.from(b.idl.accounts.find(a=>a.name===name).discriminator).copy(bytes);b.coder.types.encode(name,value).copy(bytes,8);return bytes}
function eventBytes(b,name,value){return Buffer.concat([tag,Buffer.from(b.idl.events.find(e=>e.name===name).discriminator),b.coder.types.encode(name,value)])}
function decode(b,name,account){check(account&&!account.executable);const bytes=raw(account.dataBase64),v=b.coder.accounts.decode(name,bytes);check(accountBytes(b,name,v).equals(bytes));return v}
function context(input){
 check(input?.schema==='repoing/max-wallet-launch-settlement-context/1')
 const ci=input.compilationInput,plan=compileMaxWalletLaunchReview(ci),p=JSON.parse(ci.profile.json)
 const bindings={launch:binding(JSON.parse(raw(ci.profile.idls.launch))),swap:binding(JSON.parse(raw(ci.profile.idls.swap))),token:binding(tokenIdl)}
 // Token IDL is used only as a frozen account-layout codec, never to choose a
 // program address. Actual token identity and executable bytes are operator-pinned.
 const before=new Map(ci.observations[0].accounts.map(x=>[x.address,x.account]))
 return {ci,plan,p,b:bindings,before}
}
// Pure expected-state derivation: no acceptance/authority. Useful for offline
// verification and local synthetic tests; callers cannot provide expected bytes.
export function deriveMaxWalletLaunchPostconditions(settlementContext,{slot,timestamp}){
 int(slot);int(timestamp)
 const {ci,plan,p,b,before}=context(settlementContext),r=plan.request,a=plan.addresses,{launch:L,swap:S,token:T,gate:G}=p.programs
 const lc=decode(b.launch,'Config',before.get(a.launchConfig)),sc=decode(b.swap,'Config',before.get(a.swapConfig)),auth=decode(b.launch,'CreatorAuthorization',before.get(a.authorization))
 const quote=decode(b.token,'Mint',before.get(p.quoteMint)),supply=BigInt(lc.supply.toString()),curve=supply*BigInt(lc.curve_bps)/10000n,reserve=supply-curve,vbase=curve*reserve/(curve-reserve),vquote=BigInt(r.virtualQuote),graduation=vquote*(curve-reserve)/reserve
 const inclusive=r.policyVersion===2
 const kitConfig=pda(kit,'kit',pk(r.mint).toBuffer()),holder=pda(T,'holding',pk(p.quoteMint).toBuffer(),pk(kitConfig).toBuffer())
 const launch={...zeroStruct(b.launch,'Launch'),version:1,bump:bump(L,'launch',pk(r.mint).toBuffer()),mint:pk(r.mint),creator:pk(r.creator),pool:pk(a.pool),quote_mint:pk(p.quoteMint),
  creator_fee_bps:r.creatorFeeBps,lp_fee_bps:lc.lp_fee_bps,sniper_window_secs:lc.sniper_window_secs,sniper_start_bps:lc.sniper_start_bps,virtual_quote:bn(vquote),virtual_base:bn(vbase),graduation_quote:bn(graduation),curve_tokens:bn(curve),reserve_tokens:bn(reserve),
  reserve_holding:pk(a.launchReserve),quote_holding:pk(a.launchQuote),lp_holding:pk(a.launchLp),created_at:bn(timestamp),kit_config:pk(kitConfig),holder_vault:pk(holder),config:pk(r.selectedConfig),custom_hook:pk(G),custom_hook_flags:1}
 const pool={...zeroStruct(b.swap,'Pool'),version:1,bump:bump(S,'pool',pk(r.mint).toBuffer(),pk(p.quoteMint).toBuffer(),(()=>{const v=Buffer.alloc(2);v.writeUInt16LE(lc.lp_fee_bps);return v})(),pk(L).toBuffer()),lp_mint_bump:bump(S,'lp',pk(a.pool).toBuffer()),
  base_mint:pk(r.mint),quote_mint:pk(p.quoteMint),lp_mint:pk(a.lpMint),base_vault:pk(a.baseVault),quote_vault:pk(a.quoteVault),hook_program:pk(L),hook_flags:1985,lp_fee_bps:lc.lp_fee_bps,
  base_reserve:bn(curve),virtual_base:bn(vbase),virtual_quote:bn(vquote),curve:true,creator:pk(a.launch),created_at:bn(timestamp),hook_signer_bump:bump(S,'hook-authority',pk(L).toBuffer()),fee_model:inclusive?2:1,protocol_share_bps:sc.launch_protocol_share_bps}
 const mint={...zeroStruct(b.token,'Mint'),version:1,decimals:lc.decimals,supply:bn(supply),max_supply:bn(supply),hook_program:pk(G),hook_flags:1,name:r.name,symbol:r.symbol,uri:r.uri,created_at:bn(timestamp),creator:pk(r.creator),hook_signer_bump:bump(T,'hook-authority',pk(G).toBuffer())}
 const lpMint={...zeroStruct(b.token,'Mint'),version:1,decimals:9,mint_authority:pk(a.pool),name:Array.from(`Bordrless LP ${r.symbol}/${quote.symbol}`).slice(0,32).join(''),symbol:'BLP',created_at:bn(timestamp),creator:pk(r.creator)}
 const expected=new Map(),put=(address,owner,data)=>expected.set(address,{address,owner,executable:false,dataBase64:data.toString('base64')})
 // Mint authority is revoked after minting. Anchor serialization preserves the
 // prior Some(authority) tail when the final None value shortens its payload.
 const mintBytes=accountBytes(b.token,'Mint',{...mint,mint_authority:pk(a.launch)});b.token.coder.types.encode('Mint',mint).copy(mintBytes,8)
 put(r.mint,T,mintBytes);put(a.lpMint,T,accountBytes(b.token,'Mint',lpMint));put(a.launch,L,accountBytes(b.launch,'Launch',launch));put(a.pool,S,accountBytes(b.swap,'Pool',pool))
 for(const [role,mint,owner,amount]of [['launchReserve',r.mint,a.launch,reserve],['launchQuote',p.quoteMint,a.launch,0n],['baseVault',r.mint,a.pool,curve],['quoteVault',p.quoteMint,a.pool,0n],['launchLp',a.lpMint,a.launch,0n]]){
  put(a[role],T,accountBytes(b.token,'Holding',{...zeroStruct(b.token,'Holding'),version:1,bump:bump(T,'holding',pk(mint).toBuffer(),pk(owner).toBuffer()),mint:pk(mint),owner:pk(owner),amount:bn(amount)}))
 }
 put(a.poolRegistry,L,encodeHookAccountList({version:1,accounts:[
  {writable:true,source:{kind:'pda',program:pk(L),seeds:[{kind:'literal',bytes:Buffer.from('launch')},{kind:'account',index:2}]}},
  {writable:true,source:{kind:'pda',program:pk(T),seeds:[{kind:'literal',bytes:Buffer.from('holding')},{kind:'account',index:3},{kind:'account',index:5}]}},
  {writable:true,source:{kind:'key',key:pk(holder)}},{writable:false,source:{kind:'key',key:pk(kitConfig)}}]}))
 put(a.launchConfig,L,accountBytes(b.launch,'Config',{...lc,launches:lc.launches.addn(1)}));put(a.swapConfig,S,accountBytes(b.swap,'Config',{...sc,pools_created:sc.pools_created.addn(1)}));put(a.authorization,L,accountBytes(b.launch,'CreatorAuthorization',{...auth,consumed:auth.consumed.addn(1)}))
 if(inclusive)put(a.inclusiveFeePolicy,S,Buffer.concat([Buffer.from(sha(Buffer.from('account:InclusiveFeePolicy')),'hex').subarray(0,8),Buffer.from([1]),pk(a.pool).toBuffer(),sc.fee_collector.toBuffer(),Buffer.from([0xc4,9])]))
 const launchEvent={...zeroStruct(b.launch,'LaunchCreated'),launch:pk(a.launch),mint:pk(r.mint),creator:pk(r.creator),pool:pk(a.pool),quote_mint:pk(p.quoteMint),lp_mint:pk(a.lpMint),name:r.name,symbol:r.symbol,uri:r.uri,supply:bn(supply),decimals:lc.decimals,
  creator_fee_bps:r.creatorFeeBps,lp_fee_bps:lc.lp_fee_bps,sniper_window_secs:lc.sniper_window_secs,sniper_start_bps:lc.sniper_start_bps,virtual_quote:bn(vquote),virtual_base:bn(vbase),graduation_quote:bn(graduation),curve_tokens:bn(curve),reserve_tokens:bn(reserve),launch_fee_lamports:lc.launch_fee_lamports,config:pk(r.selectedConfig),custom_hook:pk(G),custom_hook_flags:1,slot:bn(slot),ts:bn(timestamp)}
 const poolEvent={...zeroStruct(b.swap,'PoolCreated'),pool:pk(a.pool),payer:pk(r.creator),creator:pk(a.launch),base_mint:pk(r.mint),quote_mint:pk(p.quoteMint),lp_mint:pk(a.lpMint),base_vault:pk(a.baseVault),quote_vault:pk(a.quoteVault),
  lp_fee_bps:lc.lp_fee_bps,fee_model:inclusive?2:1,protocol_share_bps:sc.launch_protocol_share_bps,hook_program:pk(L),hook_flags:1985,virtual_base:bn(vbase),virtual_quote:bn(vquote),base_reserve:bn(curve),curve:true,slot:bn(slot),ts:bn(timestamp)}
 return {accounts:[...expected.values()],events:[{program:L,name:'LaunchCreated',dataBase64:eventBytes(b.launch,'LaunchCreated',launchEvent).toString('base64')},{program:S,name:'PoolCreated',dataBase64:eventBytes(b.swap,'PoolCreated',poolEvent).toString('base64')}],created:[r.mint,...['launch','pool','lpMint','launchReserve','launchQuote','poolRegistry','baseVault','quoteVault','launchLp',...(inclusive?['inclusiveFeePolicy']:[])].map(n=>a[n])],feesLamports:lc.launch_fee_lamports.add(sc.pool_creation_fee_lamports).toString(),treasury:key(lc.treasury)}
}
function authenticatedEvents(tx,b,programs){
 const keys=tx.keys,events=[],groups=new Set()
 for(const group of tx.innerInstructions){check(int(group.index)<tx.instructions.length&&!groups.has(group.index));groups.add(group.index)
  const stack=[null,keys[tx.instructions[group.index].programIdIndex]]
  for(const ix of group.instructions){const program=keys[ix.programIdIndex],h=ix.stackHeight;check(program&&Number.isInteger(h)&&h>=2&&h<=stack.length);stack.length=h;const parent=stack[h-1];stack[h]=program
   const role=program===programs.launch?'launch':program===programs.swap?'swap':null;if(!role)continue
   const bytes=Buffer.from(bs58.decode(ix.data));if(!bytes.subarray(0,8).equals(tag))continue
   check(parent===program&&ix.accounts.length===1&&keys[ix.accounts[0]]===pda(program,'__event_authority'))
   const decoded=b[role].coder.events.decode(bytes.subarray(8).toString('base64'));check(decoded&&eventBytes(b[role],decoded.name,decoded.data).equals(bytes))
   if(['LaunchCreated','PoolCreated'].includes(decoded.name)){check(group.index===2);events.push({program,name:decoded.name,dataBase64:bytes.toString('base64'),data:normalize(decoded.data)})}
  }
 }
 return events
}
export async function collectMaxWalletLaunchSettlement({config,profile,dossierJson,connections,settlementContext,review,signedTransactionBase64,signature}){
 let identity={signature,messageSha256:review?.messageSha256,profileSha256:review?.profileSha256,configurationSha256:settlementContext?.configurationSha256}
 try{
  const {config:c,dossier:d}=validateMaxWalletOperatorBindings({config,profile,dossierJson,connections}),{ci,plan,p,b,before}=context(settlementContext)
  check(settlementContext.configurationSha256===sha(JSON.stringify(c))&&isDeepStrictEqual(ci.profile,profile)&&isDeepStrictEqual(plan.review,review))
  for(const pin of d.accounts){const account=before.get(pin.address);check(productionAccountBindingMatches(pin,account,d))}
  const signed=verifyHookLabSignedMessage(review,signedTransactionBase64);check(signed.signature===signature&&review.profileSha256===c.profileSha256)
  identity={signature,messageSha256:signed.messageSha256,profileSha256:c.profileSha256,configurationSha256:sha(JSON.stringify(c))}
  const snapshotInventory=[...new Set([...before.keys(),...d.programs.flatMap(x=>[x.address,x.programData])])].sort()
  const observed=await Promise.all(connections.map(async({connection})=>{
   check(await read(()=>connection.getGenesisHash())===p.genesisHash)
   const t=await read(()=>connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0}));if(!t)return null
   const slot=int(t.slot),meta=t.meta;check(meta&&meta.err!==undefined&&Array.isArray(meta.innerInstructions))
   const wire=new VersionedTransaction(t.transaction.message);wire.signatures=t.transaction.signatures.map(x=>bs58.decode(x));check(Buffer.from(wire.serialize()).toString('base64')===signedTransactionBase64)
   const loaded=meta.loadedAddresses??{writable:[],readonly:[]},keys=t.transaction.message.getAccountKeys({accountKeysFromLookups:loaded}),all=Array.from({length:keys.length},(_,i)=>key(keys.get(i)))
   check(isDeepStrictEqual(all,review.accounts.map(x=>x.address))&&meta.preBalances.length===all.length&&meta.postBalances.length===all.length)
   const block=await read(()=>connection.getBlockSignatures(slot,'finalized'))
   check(block&&key(pk(block.blockhash))===block.blockhash&&key(pk(block.previousBlockhash))===block.previousBlockhash&&block.blockhash!==block.previousBlockhash
    &&Array.isArray(block.signatures)&&block.signatures.every(x=>bs58.decode(x).length===64&&bs58.encode(bs58.decode(x))===x)&&block.signatures.filter(x=>x===signature).length===1&&new Set(block.signatures).size===block.signatures.length&&int(block.parentSlot)<slot&&int(block.blockHeight)<=review.lastValidBlockHeight)
   check(slot>=review.observedSlot&&slot<=review.validUntilSlot&&block.blockHeight>=ci.recentBlockhash.currentBlockHeight)
   const transaction={slot,wire:signedTransactionBase64,error:meta.err,fee:String(int(meta.fee)),keys:all,pre:meta.preBalances.map(x=>String(int(x))),post:meta.postBalances.map(x=>String(int(x))),
    instructions:t.transaction.message.compiledInstructions.map(x=>({programIdIndex:x.programIdIndex,accounts:[...x.accountKeyIndexes],data:bs58.encode(x.data)})),innerInstructions:meta.innerInstructions}
   const inclusion={slot,parentSlot:block.parentSlot,blockHeight:block.blockHeight,blockhash:block.blockhash,previousBlockhash:block.previousBlockhash,transactionIndex:block.signatures.indexOf(signature)}
   const snapshot=meta.err===null?await read(()=>connection.getMultipleAccountsInfoAndContext(snapshotInventory.map(pk),{commitment:'finalized',minContextSlot:slot})):null
   if(snapshot)check(int(snapshot.context.slot)>=slot&&snapshot.value.length===snapshotInventory.length)
   return {transaction,inclusion,accounts:snapshot?snapshot.value.map((v,i)=>v?{address:snapshotInventory[i],owner:key(v.owner),executable:v.executable,dataBase64:Buffer.from(v.data).toString('base64')}:null):null}
  }))
  if(observed.some(x=>x===null))return {...identity,status:'unresolved'}
  if(!isDeepStrictEqual(observed[0],observed[1]))return {...identity,status:'conflict'}
  const {transaction:t,inclusion,accounts}=observed[0],fee=BigInt(inspectHookLabMessage(review).totalFeeLamports);check(BigInt(t.fee)===fee)
  const deltas=new Map(),add=(address,n)=>deltas.set(address,(deltas.get(address)??0n)+n)
  add(review.payer,-fee)
  if(t.error!==null){check(t.keys.every((k,i)=>BigInt(t.post[i])-BigInt(t.pre[i])===(deltas.get(k)??0n)));return {...identity,status:'finalized-failure',inclusion,transactionSha256:sha(JSON.stringify(t)),feeLamports:String(fee)}}
  const events=authenticatedEvents(t,b,p.programs);check(events.length===2&&events.filter(x=>x.name==='LaunchCreated').length===1&&events.filter(x=>x.name==='PoolCreated').length===1)
  const timestamp=Number(events.find(x=>x.name==='LaunchCreated').data.ts),expected=deriveMaxWalletLaunchPostconditions(settlementContext,{slot:t.slot,timestamp})
  check(isDeepStrictEqual(events.map(({data,...e})=>e).sort((a,b)=>a.name.localeCompare(b.name)),expected.events.sort((a,b)=>a.name.localeCompare(b.name))))
  const want=new Map(expected.accounts.map(x=>[x.address,x])),actual=new Map(snapshotInventory.map((k,i)=>[k,accounts[i]]))
  for(const pin of d.programs){const pd=actual.get(pin.programData);check(pd&&pd.owner==='BPFLoaderUpgradeab1e11111111111111111111111'&&!pd.executable&&sha(raw(pd.dataBase64))===pin.programDataSha256&&pin.deploySlot<=t.slot)}
  for(const [address,old]of before){const desired=want.get(address)??(old?(({lamports,...v})=>v)(old):null);check(isDeepStrictEqual(actual.get(address),desired))}
  let rent=0n
  for(const address of expected.created){const i=t.keys.indexOf(address);check(i>=0&&BigInt(t.post[i])>0n&&BigInt(t.post[i])>=BigInt(t.pre[i]));const increase=BigInt(t.post[i])-BigInt(t.pre[i]);rent+=increase;add(address,increase)}
  const fees=BigInt(expected.feesLamports),debit=rent+fees
  check(rent<=BigInt(ci.limits.maxRentLamports)&&debit<=BigInt(ci.limits.maxInstructionDebitLamports)&&debit+fee<=BigInt(ci.limits.maxTotalDebitLamports))
  add(plan.request.creator,-debit);add(expected.treasury,fees)
  check(t.keys.every((k,i)=>BigInt(t.post[i])-BigInt(t.pre[i])===(deltas.get(k)??0n)))
  return {...identity,status:'finalized-success',inclusion,transactionSha256:sha(JSON.stringify(t)),postStateSha256:sha(JSON.stringify(accounts)),eventsSha256:sha(JSON.stringify(expected.events)),feeLamports:String(fee),rentLamports:String(rent),instructionDebitLamports:String(debit)}
 }catch{return {...identity,status:'unresolved'}}
}
