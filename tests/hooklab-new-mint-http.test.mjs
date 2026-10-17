import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createNewMintPreparationHandler } from '../app/lib/hooklab-new-mint-preparation.mjs'
import { newMintReviewInput,newMintReviewProjection } from '../app/lib/hooklab-new-mint-client.mjs'
const address=n=>Keypair.fromSeed(Buffer.alloc(32,n)).publicKey.toBase58(),wallet=address(1),id='11111111-1111-4111-8111-111111111111',token=Buffer.alloc(32,9).toString('base64url')
const input={operationId:id,wallet,capBps:100,label:'coin'},env={HOOK_WALLET_NEW_MINT_REVIEW_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true'}
const config={origin:'https://repo.ing',enabled:true,audience:'general-launcher'},pool={end:async()=>{}},principalStore=()=>({resolve:async()=>({wallet})})
const options={env,configuration:()=>config,database:()=>pool,quota:async()=>true,principalStore}
const request=(body=input,headers={},url='https://repo.ing/api/hook-lab/new-mint-preparation')=>new Request(url,{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',cookie:`__Host-hook-wallet-session=${token}`,...headers},body:JSON.stringify(body)})
test('new mint route default off; configured production route returns honest gates without generating or returning bytes',async()=>{
 assert.equal((await createNewMintPreparationHandler()(request())).status,404)
 const response=await createNewMintPreparationHandler(options)(request()),value=await response.json()
 assert.equal(value.status,'blocked');assert.equal(value.operationId,id);assert.equal(value.productionUnsignedMessage,null);assert.equal(value.canSign,false)
 assert.deepEqual(value.blockers.map(x=>x.code),['OWNER_CUSTODY_APPROVAL_REQUIRED','OPERATOR_DEPLOYMENT_APPROVAL_REQUIRED'])
 assert.equal(response.headers.get('cache-control'),'private, no-store')
})
test('new mint HTTP rejects cross origin, unknown fields, cookie ambiguity, oversized body, query and owner mismatch',async()=>{
 const handler=createNewMintPreparationHandler(options)
 for(const [req,status] of [[request(input,{origin:'https://evil.invalid'}),403],[request({...input,secretKey:'not-accepted'}),400],
  [request(input,{cookie:`__Host-hook-wallet-session=${token}; __Host-hook-wallet-session=${token}`}),409],
  [request({...input,label:'x'.repeat(3000)}),400],[request(input,{},'https://repo.ing/api/hook-lab/new-mint-preparation?id=bad'),400],
  [request({...input,wallet:address(2)}),403],[request(input,{cookie:''}),401]])assert.equal((await handler(req)).status,status)
 assert.equal((await createNewMintPreparationHandler({...options,quota:async()=>false})(request())).status,429)
 assert.equal((await createNewMintPreparationHandler({...options,principalStore:()=>({resolve:async()=>{throw Object.assign(Error('private token'),{status:401})}})})(request())).status,401)
})
test('injected candidate projection enforces exact owner/intent and excludes message, keys and ciphertext',async()=>{
 const candidate={custody:{operationId:id,owner:wallet,mint:address(3),selectedConfig:address(4),stage:'preparation-reviewed',revision:'1',secretKey:'never-browser'},
  request:{creator:wallet,feePayer:wallet,mint:address(3),selectedConfig:address(4),capBps:100,label:'coin'},candidateReview:{messageSha256:'a'.repeat(64),messageBase64:'never-browser',requiredSigners:[wallet,address(3),address(4)],instructionDebitLamports:'100',maxNativeDebitLamports:'200',reviewExpiresAtMs:5000}}
 const handler=createNewMintPreparationHandler({...options,candidateReview:async()=>candidate}),response=await handler(request()),value=await response.json()
 assert.equal(value.status,'candidate-review-only');assert.ok(!JSON.stringify(value).includes('never-browser'));assert.equal(value.canSubmit,false)
 assert.equal(newMintReviewProjection(value,{operationId:id,wallet}),value)
 candidate.request.capBps=101;assert.equal((await handler(request())).status,409)
})
test('client input and result validation rejects stale wallet, malformed limits and enabled authority',()=>{
 assert.deepEqual(newMintReviewInput({operationId:id,wallet,capBps:'100',label:'coin'}),input)
 for(const capBps of ['0','10000','1.5','-1',' 1'])assert.throws(()=>newMintReviewInput({operationId:id,wallet,capBps,label:'coin'}))
 assert.throws(()=>newMintReviewInput({operationId:id,wallet,capBps:'1',label:'🙂'.repeat(9)}))
 const result={status:'blocked',operationId:id,wallet,productionUnsignedMessage:null,canSign:false,canSubmit:false,executionAuthorized:false}
 assert.throws(()=>newMintReviewProjection({...result,wallet:address(2)},{operationId:id,wallet}))
 assert.throws(()=>newMintReviewProjection({...result,canSign:true},{operationId:id,wallet}))
})
