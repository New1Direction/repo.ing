// Synthetic receipts, not SBF execution evidence. Disposable seeds; no RPC or disk keys.
import BN from 'bn.js'
import bs58 from 'bs58'
import {Keypair,VersionedMessage,VersionedTransaction} from '@solana/web3.js'
import {selectedNativeSimulationFixture} from './selected-native-trade.mjs'
import {selectedLaunchCollectorFixture} from './selected-hook-launch.mjs'
import {pk,pda} from './selected-hook-preparation.mjs'
import {loadNativeArtifacts} from '../../src/hooklab-native-pins.mjs'
import {loadArtifacts} from '../../src/hooklab-owner-driver/artifacts.mjs'
import {collectNativeTradeSettlement} from '../../src/hooklab-native-trade-settlement.mjs'

export function selectedNativeSettlementFixture(side='buy') {
 const f=selectedNativeSimulationFixture(side),bindings=selectedLaunchCollectorFixture(),{plan,p,accounts}=f,a=plan.addresses,q=plan.quote,r=plan.request,buy=side==='buy'
 const tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64,'base64')))
 tx.sign([Keypair.fromSeed(Buffer.alloc(32,31))])
 const signedTransactionBase64=Buffer.from(tx.serialize()).toString('base64'),signature=bs58.encode(tx.signatures[0]),keys=plan.review.accounts.map(x=>x.address),idx=k=>keys.indexOf(k)
 const preBalances=keys.map(k=>Number(accounts.get(k)?.lamports??0)),postBalances=preBalances.map((v,i)=>v+Number(plan.lamportDeltas[keys[i]]??0))
 const N=x=>new BN(String(x)),creator=BigInt(q.netCreatorFee),gross=BigInt(q.grossCreatorFee),delivered=BigInt(q.delivered),amount=BigInt(r.amountIn)
 const out=buy?750000n-BigInt(q.after.baseReserve):delivered+gross,received=buy?amount-creator:9000n,cut=buy?out-delivered:amount-received
 const paid=creator?[{holding:pk(a.launch),amount:N(creator)}]:[],pool=f.coders.swap.accounts.decode('Pool',Buffer.from(accounts.get(a.pool).dataBase64,'base64'))
 const events={
  InclusiveCreatorFeeAccrued:{version:1,pool:pk(a.pool),quote_mint:pk(p.quoteMint),direction:buy?1:0,gross_quote:N(gross),platform_quote:N(q.protocolFee),creator_quote:N(creator),creator_holding:pk(a.launch),platform_collector:pk(q.platformCollector),protocol_fees_quote_after:N(q.after.protocolFeesQuote)},
  Swapped:{pool:pk(a.pool),trader:pk(r.trader),recipient:pk(r.trader),direction:buy?1:0,amount_in:N(amount),deltas_in:buy?paid:[],burn_in:N(0),cuts_in:N(buy?creator:cut),received_in:N(received),lp_fee:N(0),protocol_fee:N(q.protocolFee),lp_fee_bps:0,amount_out:N(out),deltas_out:buy?[]:paid,burn_out:N(0),cuts_out:N(buy?cut:creator),delivered_out:N(delivered),base_reserve:N(q.after.baseReserve),quote_reserve:N(q.after.quoteReserve),virtual_base:pool.virtual_base,virtual_quote:pool.virtual_quote,swap_count:N(1),slot:N(110),ts:N(1000)},
  SwappedNative:{pool:pk(a.pool),direction:buy?1:0,quote_lamports:N(buy?amount-creator:delivered),quote_deltas:paid,pool_lamports:N(postBalances[idx(a.pool)])},
  Transferred:{mint:pk(r.mint),source:pk(buy?a.baseVault:a.traderBase),destination:pk(buy?a.traderBase:a.baseVault),source_owner:pk(buy?a.pool:r.trader),destination_owner:pk(buy?r.trader:a.pool),authority:pk(buy?a.pool:r.trader),amount:N(buy?out:amount),deltas:[{holding:pk(f.taxHolding),amount:N(cut)}],source_post:N(buy?q.after.baseReserve:q.after.traderBase),destination_post:N(buy?q.after.traderBase:q.after.baseReserve),slot:N(110),ts:N(1000)}
 }
 const native=loadNativeArtifacts(),token=loadArtifacts(),swapAt=tx.message.compiledInstructions.findIndex(ix=>keys[ix.programIdIndex]===p.programs.swap)
 const encode=(name,height)=>{
  const role=name==='Transferred'?'token':'swap',program=p.programs[role],idl=role==='token'?token.idls.token:native.idls.swap,coder=role==='token'?token.coders.token:native.coders.swap
  return {programIdIndex:idx(program),accounts:[idx(pda(program,'__event_authority'))],stackHeight:height,data:bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(idl.events.find(e=>e.name===name).discriminator),coder.types.encode(name,events[name])]))}
 }
 const receipt={slot:110,transaction:{message:tx.message,signatures:tx.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee:5000,preBalances,postBalances,innerInstructions:[]}}
 const rebuild=()=>{receipt.meta.innerInstructions=[{index:swapAt,instructions:[...['InclusiveCreatorFeeAccrued','Swapped','SwappedNative'].map(n=>encode(n,2)),{programIdIndex:idx(p.programs.token),accounts:[],stackHeight:2,data:''},encode('Transferred',3)]}]}
 rebuild()
 const connections=f.input.profile.providers.map((provider,i)=>({provider,connection:{rpcEndpoint:bindings.connections[i].connection.rpcEndpoint,getGenesisHash:async()=>p.genesisHash,getTransaction:async()=>structuredClone(receipt),getBlockSignatures:async()=>({blockhash:f.input.recentBlockhash.blockhash,previousBlockhash:p.quoteMint,parentSlot:109,blockHeight:110,signatures:[signature]}),getMultipleAccountsInfoAndContext:async ks=>({context:{slot:110},value:ks.map(k=>{const v=accounts.get(k.toBase58());return v?{owner:pk(v.owner),executable:v.executable,data:Buffer.from(v.dataBase64,'base64')}:null})})}}))
 // Keep the actual web3 Message instance (structuredClone loses its methods).
 for(const {connection} of connections)connection.getTransaction=async()=>({...receipt,transaction:receipt.transaction,meta:structuredClone(receipt.meta)})
 const args={config:bindings.config,profile:f.input.profile,dossierJson:bindings.dossierJson,connections,settlementContext:{schema:'repoing/native-trade-settlement-context/1',compilationInput:f.input},review:plan.review,signedTransactionBase64,signature}
 return {...f,args,events,receipt,rebuild,settle:overrides=>collectNativeTradeSettlement({...args,...overrides})}
}
