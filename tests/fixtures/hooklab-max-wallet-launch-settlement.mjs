// Synthetic transaction, inclusion and account evidence. Never production RPC.
import {createHash} from 'node:crypto'
import {BorshCoder} from '@anchor-lang/core'
import {Keypair,PublicKey,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import bs58 from 'bs58'
import {maxWalletOperatorFixture} from './hooklab-max-wallet-operator.mjs'
import {maxWalletLaunchInventory,compileMaxWalletLaunchReview,buildMaxWalletLaunchReviewForFixture} from '../../src/hooklab-max-wallet-launch.mjs'
import {parseMaxWalletPreparationRequest} from '../../src/hooklab-inclusive-max-wallet-profile.mjs'
import {collectMaxWalletLaunchReview} from '../../src/hooklab-max-wallet-launch-collector.mjs'
import {deriveMaxWalletLaunchPostconditions} from '../../src/hooklab-max-wallet-launch-settlement.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x)
export async function maxWalletSettlementFixture(){
 const signers=Object.fromEntries(['creator','mint','reviewer','selectedConfig'].map((r,i)=>[r,Keypair.fromSeed(createHash('sha256').update(`SYNTHETIC SETTLEMENT TEST ONLY ${i}`).digest())]))
 const f=maxWalletOperatorFixture(input=>rebindMaxWalletLaunchFixture(input,Object.fromEntries(Object.entries(signers).map(([role,signer])=>[role,signer.publicKey.toBase58()]))))
 const collected=await collectMaxWalletLaunchReview(f),review=collected.plan.review,settlementContext=collected.settlementContext,tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(review.messageBase64,'base64')))
 tx.sign(review.requiredSigners.map(k=>Object.values(signers).find(s=>s.publicKey.toBase58()===k)))
 const signedTransactionBase64=Buffer.from(tx.serialize()).toString('base64'),signature=bs58.encode(tx.signatures[0]),slot=review.observedSlot+1,timestamp=1700000001,expected=deriveMaxWalletLaunchPostconditions(settlementContext,{slot,timestamp})
 const accounts=new Map(f.accounts),post=new Map(expected.accounts.map(a=>[a.address,{...a,lamports:expected.created.includes(a.address)?'1000000':accounts.get(a.address)?.lamports??'1000000'}]))
 for(const [k,v]of post)accounts.set(k,v)
 const keys=review.accounts.map(a=>a.address),idx=k=>keys.indexOf(k),preBalances=keys.map(k=>Number(f.accounts.get(k)?.lamports??0)),postBalances=[...preBalances]
 let rent=0;for(const address of expected.created){const i=idx(address);postBalances[i]=1000000;rent+=postBalances[i]-preBalances[i]}
 postBalances[idx(f.request.creator)]-=rent+Number(expected.feesLamports)+Number(f.f.recentBlockhash.networkFeeLamports);postBalances[idx(expected.treasury)]+=Number(expected.feesLamports)
 const profile=JSON.parse(f.profile.json),events=expected.events,swap=profile.programs.swap
 const innerInstructions=[{index:2,instructions:[{programIdIndex:idx(swap),accounts:[],data:bs58.encode(Buffer.from([1])),stackHeight:2},
  ...events.filter(e=>e.name==='PoolCreated').map(e=>({programIdIndex:idx(e.program),accounts:[idx(collected.plan.addresses.swapEventAuthority)],data:bs58.encode(Buffer.from(e.dataBase64,'base64')),stackHeight:3})),
  ...events.filter(e=>e.name==='LaunchCreated').map(e=>({programIdIndex:idx(e.program),accounts:[idx(collected.plan.addresses.eventAuthority)],data:bs58.encode(Buffer.from(e.dataBase64,'base64')),stackHeight:2}))]}]
 const loaded=review.accounts.slice(tx.message.staticAccountKeys.length),transaction={slot,transaction:{message:tx.message,signatures:tx.signatures.map(x=>bs58.encode(x))},meta:{err:null,fee:Number(f.f.recentBlockhash.networkFeeLamports),preBalances,postBalances,
  loadedAddresses:{writable:loaded.filter(x=>x.writable).map(x=>pk(x.address)),readonly:loaded.filter(x=>!x.writable).map(x=>pk(x.address))},innerInstructions}}
 const block={parentSlot:slot-1,blockHeight:slot,blockhash:pk(Buffer.alloc(32,161)).toBase58(),previousBlockhash:pk(Buffer.alloc(32,162)).toBase58(),signatures:[signature]}
 for(const {connection}of f.connections){connection.getTransaction=async()=>transaction;connection.getBlock=async()=>block;connection.getMultipleAccountsInfoAndContext=async keys=>({context:{slot:slot+2},value:keys.map(k=>{const a=accounts.get(k.toBase58());return a?{owner:pk(a.owner),executable:a.executable,lamports:Number(a.lamports),data:Buffer.from(a.dataBase64,'base64')}:null})})}
 return {...f,review,settlementContext,signedTransactionBase64,signature,transaction,block,postAccounts:accounts,expected}
}

export function rebindMaxWalletLaunchFixture(input,identities){
  const oldPlan=(input.request.policyVersion===2?compileMaxWalletLaunchReview:buildMaxWalletLaunchReviewForFixture)(input),old={...input.request},p=JSON.parse(input.profile.json),r=input.request
  for(const role of Object.keys(identities))r[role]=identities[role];r.feePayer=r.creator
  const b=Object.fromEntries(['launch','swap','gate'].map(role=>[role,new BorshCoder(JSON.parse(Buffer.from(input.profile.idls[role],'base64')))]))
  const config=Buffer.from(input.observations[0].accounts.find(x=>x.address===oldPlan.addresses.launchConfig).account.dataBase64,'base64')
  const next=maxWalletLaunchInventory(input.profile,r,config),mapping=new Map(Object.entries(oldPlan.addresses).map(([k,v])=>[v,next.addresses[k]]))
  for(const role of Object.keys(identities))mapping.set(old[role],r[role]);mapping.set(old.feePayer,r.feePayer)
  const accounts=input.observations[0].accounts.map(x=>({address:mapping.get(x.address)??x.address,account:x.account?{...x.account,address:mapping.get(x.address)??x.address}:null})),map=new Map(accounts.map(x=>[x.address,x.account]))
  function edit(role,name,address,fn){const a=map.get(address),raw=Buffer.from(a.dataBase64,'base64'),v=b[role].accounts.decode(name,raw);fn(v);const out=Buffer.alloc(raw.length);raw.subarray(0,8).copy(out);b[role].types.encode(name,v).copy(out,8);a.dataBase64=out.toString('base64')}
  edit('launch','Config',next.addresses.launchConfig,v=>{v.admin=pk(r.reviewer)})
  edit('launch','Governance',next.addresses.launchGovernance,v=>{v.state.roles.admin=pk(r.reviewer)})
  edit('launch','CreatorAuthorization',next.addresses.authorization,v=>{v.creator=pk(r.creator)})
  edit('launch','LaunchConfig',r.selectedConfig,v=>{v.creator=pk(r.creator)})
  edit('gate',r.policyVersion===2?'PolicyV2':'Policy',next.addresses.policy,v=>{v.mint=pk(r.mint)})
  map.get(next.addresses.registry).dataBase64=Buffer.concat([Buffer.from('02daf6662c38c0cd01020000000000','hex'),pk(next.addresses.policy).toBuffer(),Buffer.from([0,0]),pk(next.addresses.launch).toBuffer()]).toString('base64')
  for(const o of input.observations)o.accounts=structuredClone(accounts)
  const hashAccount=a=>sha(Buffer.from(map.get(a).dataBase64,'base64'))
  input.preparationEvidence.preparedAccountHashes={policy:hashAccount(next.addresses.policy),registry:hashAccount(next.addresses.registry),selectedConfig:hashAccount(r.selectedConfig)}
  input.reviewedStateHashes=Object.fromEntries(Object.keys(input.reviewedStateHashes).map(k=>[k,hashAccount(k==='quoteMint'?p.quoteMint:next.addresses[k])]))
  const {reviewer,name,symbol,uri,virtualQuote,...prep}=r;input.preparationEvidence.preparationIntentSha256=sha(JSON.stringify(parseMaxWalletPreparationRequest({...prep,schema:r.policyVersion===2?'repoing/inclusive-max-wallet-preparation-request/1':'repoing/max-wallet-preparation-request/1'})))
  const table=Buffer.from(input.lookupTable.dataBase64,'base64');for(let offset=56;offset<table.length;offset+=32){const address=pk(table.subarray(offset,offset+32)).toBase58();if(mapping.has(address))pk(mapping.get(address)).toBuffer().copy(table,offset)}input.lookupTable.dataBase64=table.toString('base64');input.lookupTable.sha256=sha(table)
  return input
}
