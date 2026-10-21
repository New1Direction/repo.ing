import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reviewNewMintSelectedHookPreparationCandidate } from '../src/hooklab-new-mint-preparation.mjs'
import { observeSelectedHookCompatibility } from '../src/hooklab-selected-hook-compatibility.mjs'
import { fixture, key, pk, pda } from './fixtures/selected-hook-preparation.mjs'

const policy={schema:'repoing/selected-hook-compatibility/2',referenceCommit:'7fde54001d7f0c88b17c87babf73fb40be07b3cb',
 abi:{family:'bordrless-token-hook-v1',tokenFlagsMask:255,registryVersion:1,registryDiscriminator:'02daf6662c38c0cd',maxRegistryExtras:32,allowExtraSigners:false},
 authority:{immutable:true,timelock:{program:'BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ',minDelaySeconds:259200,requireIdle:true},trustedUpgradeAuthorities:[]}}

test('server observation is retained before registry collection; restart preserves two independent selections and rejects changed code',async()=>{
 const f=fixture(),rows=new Map(),loader='BPFLoaderUpgradeab1e11111111111111111111111'
 const store=()=>({
  async reserveNewCandidate(_token,id){if(!rows.has(id))rows.set(id,{operationId:id,custodySessionId:randomUUID(),owner:f.request.creator,profileSha256:f.profile.expectedSha256,
   mint:f.request.mint,selectedConfig:f.request.selectedConfig,stage:'reserved',revision:'0',preparedRequest:null,selectedAuthorityEvidence:null});return structuredClone(rows.get(id))},
  async retainPreparationIntent(_token,id,{expectedRevision,request,selectedAuthorityEvidence}){
   const row=rows.get(id);assert.equal(row.revision,expectedRevision)
   if(row.preparedRequest){assert.deepEqual(row.preparedRequest,request);assert.deepEqual(row.selectedAuthorityEvidence,selectedAuthorityEvidence)}
   else Object.assign(row,{preparedRequest:structuredClone(request),selectedAuthorityEvidence:structuredClone(selectedAuthorityEvidence),revision:'1'})
   return structuredClone(row)
  },
  async get(_token,id){return structuredClone(rows.get(id))},
 })
 for(const program of [key(44),key(45)]){
  const pd=pda(loader,pk(program).toBuffer()),pb=Buffer.alloc(36),db=Buffer.alloc(53)
  pb.writeUInt32LE(2);pk(pd).toBuffer().copy(pb,4);db.writeUInt32LE(3);Buffer.from([127,69,76,70,7,9,3,2]).copy(db,45)
  let changed=false,observations=0,collectionReads=0
  const readers=[0,1].map(i=>({provider:`reader-${i}`,trustDomain:`domain-${i}`,connection:{rpcEndpoint:`https://reader-${i}.invalid`,
   async getGenesisHash(){return JSON.parse(f.profile.json).genesisHash},
   async getMultipleAccountsInfoAndContext(keys){return {context:{slot:100},value:keys.map(k=>{
    const data=k.toBase58()===program?pb:k.toBase58()===pd?Buffer.concat([db,...(changed?[Buffer.from([1])]:[])]):null
    return data?{owner:pk(loader),executable:k.toBase58()===program,data}:null
   })}}
  }}))
  const observeSelectedHook=async(p,{expectedEvidence})=>{observations++;return observeSelectedHookCompatibility({program:p,expectedEvidence,policy,connections:readers,
   genesisHash:JSON.parse(f.profile.json).genesisHash,forbiddenPrograms:[JSON.parse(f.profile.json).programs.launch]})}
  const input={operationId:randomUUID(),selectedHook:{program,flags:255},label:'Selected',creatorFeeBps:100}
  const args={sessionToken:'synthetic-session',input,profile:f.profile,observeSelectedHook,hookPin:{program:key(99),elfSha256:'f'.repeat(64),elfLength:1},
   connections:f.profile.providers.map(provider=>({provider,connection:{getGenesisHash:async()=>{collectionReads++;throw Error('registry unavailable')}}})),limits:f.limits,clock:()=>1000}
  await assert.rejects(reviewNewMintSelectedHookPreparationCandidate({...args,custody:store()}))
  const retained=structuredClone(rows.get(input.operationId));assert.equal(retained.preparedRequest.feeModel,1)
  assert.equal(retained.selectedAuthorityEvidence.hookPin.program,program,'browser/local singleton is not authority')
  await assert.rejects(reviewNewMintSelectedHookPreparationCandidate({...args,custody:store()}))
  assert.deepEqual(rows.get(input.operationId),retained,'recreation retains original evidence, including observation slot')
  changed=true;const before=collectionReads
  await assert.rejects(reviewNewMintSelectedHookPreparationCandidate({...args,custody:store()}),{code:'SELECTED_HOOK_COMPATIBILITY_UNAVAILABLE'})
  assert.equal(collectionReads,before,'code change refused before preparation collection or signing')
  assert.equal(observations,3)
 }
 assert.equal(rows.size,2)
})
