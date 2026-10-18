// Retained executed SBF preparation observations; fixture-only, never production RPC evidence.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { inclusiveMaxWalletPreparationInventory } from '../../src/hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { inclusiveRustVector } from './hooklab-inclusive-max-wallet-launch.mjs'
export const sha = value => createHash('sha256').update(value).digest('hex')
export function inclusiveMaxWalletPreparationFixture() {
 const vector=inclusiveRustVector(),read=name=>readFileSync(new URL('../../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/'+name,import.meta.url))
 const json=read('offline-builder-profile.json').toString(),p=JSON.parse(json),manifest=JSON.parse(read('build-artifacts.json'))
 const profile={json,expectedSha256:sha(json),providers:['fixture-a','fixture-b'],idls:Object.fromEntries([['launch','bordrless_launch'],['gate','hook_max_wallet']].map(([r,n])=>[r,read(n+'.json').toString('base64')])),elfLengths:Object.fromEntries(['launch','gate'].map(r=>[r,manifest.artifacts[r].elfLength]))}
 const request={schema:'repoing/inclusive-max-wallet-preparation-request/1',policyKind:'max-wallet',policyVersion:2,creator:vector.request.creator,feePayer:vector.request.payer,
 mint:vector.request.futureMint,selectedConfig:vector.request.selectedConfig,capBps:vector.request.capBps,label:vector.request.label,creatorFeeBps:vector.request.creatorFeeBps,feeModel:2,protocolShareBps:2500,rules:'none',hookFlags:1}
 const rows=v=>new Map(v.map(({pubkey:address,account})=>[address,account&&{address,owner:account.owner,executable:account.executable,lamports:account.lamports,dataBase64:account.dataBase64}]))
 const before=rows(vector.preparation.accountsBefore),after=rows(vector.launch.accountsBefore),inventory=inclusiveMaxWalletPreparationInventory(p,request)
 const rents={policy:after.get(inventory[5]).lamports,registry:after.get(inventory[6]).lamports,selectedConfig:after.get(request.selectedConfig).lamports}
 const total=Object.values(rents).reduce((a,b)=>a+BigInt(b),0n),slot=Number(vector.slot)
 return {profile,request,observations:profile.providers.map(provider=>({provider,genesisHash:p.genesisHash,commitment:'finalized',slot,observedAtMs:1000,
 accounts:inventory.map(address=>{if(!before.has(address))throw Error('Retained preparation inventory incomplete');return {address,account:before.get(address)}}),rentExemptionLamports:rents})),
 recentBlockhash:{blockhash:vector.blockhash,genesisHash:p.genesisHash,providers:profile.providers,observedAtMs:1000,currentBlockHeight:slot,blockhashValid:true,lastValidBlockHeight:slot+150,observedSlot:slot,networkFeeLamports:'15000',lamportsPerSignature:'5000'},
 lookupTable:null,limits:{nowMs:1000,maxAgeMs:5000,maxSlotLag:5,validUntilSlot:slot+50,reviewExpiresAtMs:6000,maxRentLamports:String(total),maxNetworkFeeLamports:'15000',maxTotalDebitLamports:String(total+15000n),computeUnitLimit:600000,computeUnitPriceMicroLamports:'0'}}
}
