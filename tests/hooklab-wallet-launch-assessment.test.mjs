import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { maxWalletPreparationRequestSchema } from '../src/hooklab-max-wallet-preparation.mjs'
import { assessWalletLaunchPreparation } from '../src/hooklab-wallet-launch-assessment.mjs'
import { createWalletLaunchAssessmentHandler } from '../app/lib/hooklab-wallet-launch-assessment.mjs'
const key=n=>Keypair.fromSeed(Buffer.alloc(32,n)).publicKey.toBase58()
const request=maxWalletPreparationRequestSchema.parse({schema:'repoing/max-wallet-preparation-request/1',policyKind:'max-wallet',policyVersion:1,creator:key(1),feePayer:key(1),mint:key(2),selectedConfig:key(3),capBps:100,label:'fixture-review',creatorFeeBps:0,rules:'none',hookFlags:1})
const id=randomUUID(),token=Buffer.alloc(32,8).toString('base64url'),input={preparationId:id,request}
const summary={id,wallet:request.creator,mint:request.mint,preparedRequest:request,preparationIntentSha256:createHash('sha256').update(JSON.stringify(request)).digest('hex'),profileSha256:'a'.repeat(64),messageSha256:'b'.repeat(64),status:'candidate-preparation-matched',evidenceConflict:false,lastCollectionPrelaunchEligible:true}
const body=value=>new Request('https://repo.ing/api/hook-lab/wallet-launch-assessment',{method:'POST',headers:{Origin:'https://repo.ing','Content-Type':'application/json',Cookie:`__Host-hook-wallet-session=${token}`},body:JSON.stringify(value)})
function fixture(){const calls=[];return{calls,journal:{get:async(s,i)=>{calls.push(['get',s,i]);return structuredClone(summary)},reconcile:async(s,i)=>{calls.push(['reconcile',s,i]);return structuredClone(summary)}}}}
test('injected local assessment completes exact retained→fresh review but never emits production bytes or accepts adoption',async()=>{
 const f=fixture(),result=await assessWalletLaunchPreparation({journal:f.journal,sessionToken:token,input})
 assert.deepEqual(f.calls.map(c=>c[0]),['get','reconcile']);assert.equal(result.status,'blocked');assert.equal(result.unsignedLaunchMessage,null)
 for(const k of ['canSign','canSubmit','canLaunch','executionAuthorized','deploymentAdopted','preparationReceiptAccepted'])assert.equal(result[k],false)
 assert.deepEqual(result.blockers.map(b=>b.code),['OPERATOR_DEPLOYMENT_APPROVAL_REQUIRED','PRODUCTION_LAUNCH_REVALIDATION_REQUIRED'])
 await assert.rejects(assessWalletLaunchPreparation({journal:f.journal,sessionToken:token,input:{...input,adoptionApproved:true}}))
})
test('wallet/mint/cap/plan mismatch refuses before fresh reads and changed fresh profile is refused',async()=>{
 for(const change of [{creator:key(4)},{mint:key(4)},{capBps:101},{label:'different'}]){
  const f=fixture();await assert.rejects(assessWalletLaunchPreparation({journal:f.journal,sessionToken:token,input:{...input,request:{...request,...change}}}));assert.equal(f.calls.length,1)
 }
 const f=fixture();f.journal.reconcile=async()=>({...summary,profileSha256:'c'.repeat(64)})
 await assert.rejects(assessWalletLaunchPreparation({journal:f.journal,sessionToken:token,input}))
})
test('pending/conflicting/already-launched preparations keep explicit reconciliation and adoption gates',async()=>{
 for(const state of [{status:'unresolved'},{evidenceConflict:true},{lastCollectionPrelaunchEligible:false}]){
  const f=fixture();f.journal.reconcile=async()=>({...summary,...state})
  const result=await assessWalletLaunchPreparation({journal:f.journal,sessionToken:token,input});assert.equal(result.blockers[0].code,'PREPARATION_RECONCILIATION_REQUIRED');assert.equal(result.unsignedLaunchMessage,null)
 }
})
test('HTTP boundary defaults off, binds cookie, enforces CSRF/strict input and completes local assessment without bytes',async()=>{
 const f=fixture(),calls=[]
 const options={env:{HOOK_WALLET_LAUNCH_ASSESSMENT_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true'},configuration:()=>({origin:'https://repo.ing'}),database:()=>({end:async()=>calls.push('end')}),journal:()=>f.journal,quota:async()=>true}
 const off=createWalletLaunchAssessmentHandler({...options,env:{},configuration:()=>assert.fail('disabled config')});assert.equal((await off({})).status,404)
 const handler=createWalletLaunchAssessmentHandler(options)
 const response=await handler(body(input));assert.equal(response.status,200);assert.equal((await response.json()).unsignedLaunchMessage,null);assert.equal(f.calls[0][1],token)
 const wrong=body(input);wrong.headers.set('Origin','https://evil.invalid');assert.equal((await handler(wrong)).status,403)
 const anonymous=body(input);anonymous.headers.delete('Cookie');assert.equal((await handler(anonymous)).status,401)
 assert.equal((await handler(body({...input,productionAccepted:true}))).status,400)
 const limited=createWalletLaunchAssessmentHandler({...options,quota:async()=>false});assert.equal((await limited(body(input))).status,429)
 const read=await handler(new Request(`https://repo.ing/api/hook-lab/wallet-launch-assessment?id=${id}`,{headers:{Cookie:`__Host-hook-wallet-session=${token}`}}))
 assert.equal(read.status,200);assert.deepEqual((await read.json()).preparation.preparedRequest,request)
})
