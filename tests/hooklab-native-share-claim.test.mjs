import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import {selectedNativeTradeFixture} from './fixtures/selected-native-trade.mjs'
import {key,pk} from './fixtures/selected-hook-preparation.mjs'
import {compileNativeClaimReview,nativeClaimInventory,verifyNativeClaimReceipt} from '../src/hooklab-native-claim.mjs'
import {loadNativeArtifacts} from '../src/hooklab-native-pins.mjs'
import {pda} from './fixtures/selected-hook-preparation.mjs'
import bs58 from 'bs58'
import {createHash} from 'node:crypto'
import {nativeClaimResolver} from '../src/hooklab-native-claim-resolver.mjs'
import {selectedLaunchCollectorFixture} from './fixtures/selected-hook-launch.mjs'

function fixture(role='creator',withPartner=false){
 const f=selectedNativeTradeFixture(),author=key(97),creator=f.request.trader,request={schema:'repoing/hooklab-native-claim-request/1',creator:role==='author'?author:creator,mint:f.request.mint,...(role==='author'?{claimantRole:'author'}:{})}
 for(const [role,name,address,change] of [['launch','Launch',f.a.launch,l=>{l.author_share_bps=1733;l.creator_fees_claimed=new BN(0)}],['launch','LaunchConfig',f.request.selectedConfig,l=>{l.creator=pk(author);l.author_share_bps=1733}]]){
  const row=f.accounts.get(address),b=Buffer.from(row.dataBase64,'base64'),v=f.coders[role].accounts.decode(name,b);change(v);f.coders[role].types.encode(name,v).copy(b,8);row.dataBase64=b.toString('base64')
 }
 f.accounts.set(author,{...f.accounts.get(creator),address:author})
 const partner=key(96),partnerFee=pda(f.p.programs.launch,'partner',pk(f.request.selectedConfig).toBuffer())
 if(withPartner){
  const row=f.accounts.get(f.a.launch),b=Buffer.from(row.dataBase64,'base64'),l=f.coders.launch.accounts.decode('Launch',b)
  l.reserved[14]=2711&255;l.reserved[15]=2711>>8;l.reserved[16]=PublicKey.findProgramAddressSync([Buffer.from('partner'),pk(f.request.selectedConfig).toBuffer()],pk(f.p.programs.launch))[1];f.coders.launch.types.encode('Launch',l).copy(b,8);row.dataBase64=b.toString('base64')
  const pf=Buffer.alloc(116);createHash('sha256').update('account:PartnerFee').digest().copy(pf,0,0,8);pf[8]=1;pf[9]=l.reserved[16];pk(f.request.selectedConfig).toBuffer().copy(pf,10);pk(partner).toBuffer().copy(pf,42);pf.writeUInt16LE(2711,74)
  f.accounts.set(partnerFee,{address:partnerFee,owner:f.p.programs.launch,executable:false,lamports:'2000000',dataBase64:pf.toString('base64')});f.accounts.set(partner,{...f.accounts.get(creator),address:partner})
 }
 const profile={genesisHash:f.p.genesisHash,programs:f.p.programs,profileSha256:f.input.profile.expectedSha256,providers:f.input.profile.providers,launchElf:{trimmedSha256:f.p.elfSha256.launch,trimmedLength:f.input.profile.elfLengths.launch}}
 const inventory=nativeClaimInventory(profile,request,f.accounts),observations=f.input.observations.map(o=>({...o,accounts:inventory.map(address=>({address,account:f.accounts.get(address)??null}))}))
 const input={profile,request,observations,rent:{launchLamports:String(BigInt(f.accounts.get(f.a.launch).lamports)-1000003n),walletLamports:'890880'},recentBlockhash:f.input.recentBlockhash,limits:f.input.limits}
 return {input,author,creator,partner,partnerFee,f,compile:()=>compileNativeClaimReview(input)}
}
import {PublicKey} from '@solana/web3.js'

function resolverFixture(role,mutate=()=>{}){
 const f=fixture(role,true),bindings=selectedLaunchCollectorFixture(),reads=[[],[]]
 const connections=bindings.connections.map(({provider,connection},index)=>({provider,connection:{...connection,
  getMultipleAccountsInfoAndContext:async(keys,options)=>{
   const addresses=keys.map(k=>k.toBase58());reads[index].push(addresses)
   const value=addresses.map(address=>{const a=f.f.accounts.get(address);return a?{owner:pk(a.owner),executable:a.executable,lamports:Number(a.lamports),data:Buffer.from(a.dataBase64,'base64')}:null})
   mutate({index,addresses,value})
   return {context:{slot:Math.max(100,options.minContextSlot)},value}
  },getMinimumBalanceForRentExemption:async bytes=>Number(bytes===0?f.input.rent.walletLamports:f.input.rent.launchLamports),
  getSlot:async()=>100,getFeeForMessage:async()=>({value:5000}),simulateTransaction:async()=>({value:{err:null}})
 }}))
 const resolver=nativeClaimResolver({...bindings,connections,limits:f.input.limits,clock:()=>1000})
 return {...f,reads,resolver,prepare:()=>resolver.prepare({owner:f.input.request.creator,stage:'native-claim',intent:{mint:f.input.request.mint,...(role==='author'?{claimantRole:'author'}:{})}})}
}
for(const role of ['creator','author'])test(`${role} resolver discovers config, partner and payout destinations independently on both providers`,async()=>{
 const f=resolverFixture(role),prepared=await f.prepare()
 assert.equal(prepared.request.claimantRole,role==='author'?'author':undefined)
 for(const reads of f.reads){
  assert.equal(reads.length,3)
  assert.ok(!reads[0].includes(f.partnerFee))
  assert.ok(reads[1].includes(f.partnerFee))
  assert.ok(reads[2].includes(f.partner)&&reads[2].includes(f.author)&&reads[2].includes(f.creator))
 }
 await f.resolver.revalidate({owner:f.input.request.creator,stage:'native-claim',review:prepared.review,configurationSha256:prepared.configurationSha256,settlementContext:prepared.settlementContext})
})
test('claim resolver rejects different provider destination discovery',async()=>{
 const f=resolverFixture('author',({index,addresses,value})=>{
  const i=addresses.indexOf(f.partnerFee)
  if(index===1&&i>=0){const b=Buffer.from(value[i].data);pk(key(98)).toBuffer().copy(b,42);value[i].data=b}
 })
 await assert.rejects(f.prepare,/Providers disagree/)
})
test('claim resolver accepts destination wallet lamport drift but not immutable config changes',async()=>{
 const f=resolverFixture('creator',({index,addresses,value})=>{
  if(index===1)for(const address of [f.author,f.partner]){const i=addresses.indexOf(address);if(i>=0)value[i].lamports++}
 })
 await f.prepare()
 const bad=resolverFixture('creator',({index,addresses,value})=>{
  const i=addresses.indexOf(bad.f.request.selectedConfig)
  if(index===1&&i>=0)value[i].data[value[i].data.length-1]^=1
 })
 await assert.rejects(bad.prepare,/Providers disagree/)
})
for(const role of ['creator','author'])test(`${role} claims whole native balance with independent floor author split, no protocol charge`,()=>{
 const f=fixture(role),p=f.compile()
 assert.equal(p.quote.creatorLamports,'826703')
 assert.equal(p.quote.authorLamports,'173300')
 assert.equal(p.quote.claimableLamports,'1000003')
 assert.deepEqual(p.review.requiredSigners,[f.input.request.creator])
 assert.ok(p.instructions.at(-1).accounts.some(x=>x.address===f.author&&x.writable))
 assert.ok(p.instructions.at(-1).accounts.some(x=>x.address===f.creator&&x.writable))
})
test('author signer is authenticated by immutable config, not a request assertion',()=>{
 const f=fixture('author');f.input.request.creator=key(98)
 assert.throws(f.compile)
})
test('partner share is independently floored from available native lamports and paid with creator claim',()=>{
 const f=fixture('creator',true),p=f.compile()
 assert.equal(p.quote.creatorLamports,'555603')
 assert.equal(p.quote.partnerLamports,'271100')
 assert.equal(p.quote.authorLamports,'173300')
 assert.deepEqual(p.instructions.at(-1).accounts.slice(-2).map(x=>x.address),[f.partnerFee,f.partner])
 f.input.observations[0].accounts.find(x=>x.address===f.partnerFee).account.owner=key(99)
 assert.throws(f.compile)
})

for(const [role,withPartner] of [['creator',false],['author',false],['creator',true],['author',true]])test(`${role} receipt authenticates independently rounded payouts, partner=${withPartner}`,()=>{
 const f=fixture(role,withPartner),plan=f.compile(),keys=plan.review.accounts.map(a=>a.address),idx=k=>keys.indexOf(k),program=f.f.p.programs.launch,coder=loadNativeArtifacts().coders.launch
 const total=1100007n,author=total*1733n/10000n,partner=withPartner?total*2711n/10000n:0n,creator=total-author-partner,N=n=>new BN(String(n)),rent=BigInt(f.input.rent.launchLamports)
 const pre=keys.map(k=>Number(f.f.accounts.get(k)?.lamports??0)),post=[...pre];pre[idx(plan.quote.launch)]=Number(rent+total);post[idx(plan.quote.launch)]=Number(rent)
 post[idx(f.creator)]+=Number(creator);post[idx(f.author)]+=Number(author);post[idx(plan.review.payer)]-=5000
 const event={launch:pk(plan.quote.launch),mint:pk(plan.request.mint),creator:pk(f.creator),lamports:N(creator),claimed_total:N(creator),slot:N(110),ts:N(1000)}
 const paid={launch:event.launch,mint:event.mint,config:pk(plan.quote.config),author:pk(f.author),amount:N(author),paid_total:N(author),slot:N(110),ts:N(1000)}
 const encode=(name,data)=>({programIdIndex:idx(program),accounts:[idx(pda(program,'__event_authority'))],stackHeight:2,data:bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(loadNativeArtifacts().idls.launch.events.find(e=>e.name===name).discriminator),coder.types.encode(name,data)]))})
 const tx={keys,pre,post,fee:5000,error:null,innerInstructions:[{index:2,instructions:[encode('CreatorFeesClaimedSol',event),encode('AuthorFeesPaid',paid)]}]}
 if(withPartner){
  post[idx(f.partner)]+=Number(partner)
  const bytes=Buffer.alloc(176);Buffer.from('e445a52e51cb9a1d','hex').copy(bytes);createHash('sha256').update('event:PartnerFeesPaid').digest().copy(bytes,8,0,8)
  for(const [i,k] of [plan.quote.launch,plan.request.mint,plan.quote.config,f.partner].entries())pk(k).toBuffer().copy(bytes,16+i*32)
  for(const [i,n] of [partner,partner,110n,1000n].entries())bytes.writeBigUInt64LE(n,144+i*8)
  tx.innerInstructions[0].instructions.push({...encode('AuthorFeesPaid',paid),data:bs58.encode(bytes)})
 }
 const verify=()=>verifyNativeClaimReceipt({plan,rent:f.input.rent,programs:f.f.p.programs,tx})
 assert.equal(verify().claimedLamports,String(creator))
 assert.equal(verify().authorLamports,String(author))
 if(withPartner)assert.equal(verify().partnerLamports,String(partner))
 tx.post[idx(f.author)]++;assert.throws(verify);tx.post[idx(f.author)]--
 tx.innerInstructions[0].instructions.push(encode('AuthorFeesPaid',paid));assert.throws(verify)
})
