import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitHubAppVerifier } from '../src/github-verification.mjs'
import { encryptGithubSession, readGithubSession, newGithubSession, seal, readBuilderReview, readClaimReview } from '../app/lib/auth.mjs'
import { reviewedClaimAmount, assertClaimSnapshot } from '../src/claim-review.mjs'
import { claimBuilderQueue } from '../src/builder-queue.mjs'
process.env.GITHUB_APP_CLIENT_SECRET='local-builders-test-secret'
const makeVerifier = fetchImpl => createGitHubAppVerifier({ pool:{},clientId:'fixture',clientSecret:'fixture',redirectUri:'http://localhost/callback',fetchImpl })
const response = body => ({ok:true,status:200,json:async()=>body})
const user = () => newGithubSession({scope:'builders',githubRepoId:null,githubUserId:42n,githubLogin:'owner',permission:'identity',accessToken:'ghu_fixture',accessTokenExpiresAt:Date.now()+3600_000})

test('builder OAuth authenticates identity without granting repo authority or accepting bad state',async()=>{
  let requests=0
  const verifier=makeVerifier(async(url)=>{requests++;return response(url.endsWith('/access_token')?{token_type:'bearer',access_token:'ghu_fixture',expires_in:120}:{id:42,login:'owner'})})
  await assert.rejects(verifier.verifyBuilderCallback({code:'code',state:'wrong',expectedState:'state'}),/state/)
  assert.equal(requests,0)
  const result=await verifier.verifyBuilderCallback({code:'code',state:'state',expectedState:'state'})
  assert.equal(result.permission,'identity');assert.equal(result.githubRepoId,null);assert.equal(result.verified,undefined)
  assert.ok(result.accessTokenExpiresAt<=Date.now()+120_000)
  const session=newGithubSession(result)
  assert.deepEqual(readGithubSession(encryptGithubSession(session)),session)
  assert.equal(readGithubSession(encryptGithubSession({...session,permission:'admin'})),null)
})
test('admin discovery paginates, deduplicates, and excludes private, archived and non-admin repositories',async()=>{
  const calls=[]
  const first=Array.from({length:100},(_,i)=>({id:i+1,private:false,archived:false,permissions:{admin:true}}))
  const verifier=makeVerifier(async(url)=>{
    calls.push(url)
    if(url.endsWith('/user'))return response({id:42,login:'owner'})
    return response(url.endsWith('page=1')?first:[first[0],{id:101,private:true,permissions:{admin:true}},{id:102,private:false,archived:true,permissions:{admin:true}},{id:103,private:false,permissions:{push:true}},{id:104,private:false,permissions:{admin:true}}])
  })
  const ids=await verifier.listAdminRepositoryIds({accessToken:'ghu_fixture',expectedGithubUserId:'42'})
  assert.equal(ids.length,101);assert.ok(ids.includes('104'));assert.ok(!ids.includes('101'));assert.equal(calls.length,3)
  await assert.rejects(verifier.listAdminRepositoryIds({accessToken:'ghu_fixture',expectedGithubUserId:'99'}),/identity changed/)
  const failed=makeVerifier(async url=>url.endsWith('/user')?response({id:42,login:'owner'}):{status:403,ok:false})
  await assert.rejects(failed.listAdminRepositoryIds({accessToken:'ghu_fixture',expectedGithubUserId:'42'}),/unavailable/)
})
test('each dashboard review binds identity/session/repo/recipient/revision and cannot be used as a single-repo review',()=>{
  const session=user(), review={purpose:'builder-claim-review',sessionId:session.sessionId,githubUserId:'42',repoId:'123',wallet:'receiver',boundAt:new Date().toISOString(),amount:'100',paid:'20',expiresAt:Date.now()+60_000}
  const signed=seal(review)
  assert.deepEqual(readBuilderReview(signed,session),review)
  assert.throws(()=>readBuilderReview(signed,user()))
  assert.throws(()=>readClaimReview(signed,session))
  for(const patch of [{amount:'0'},{amount:'-1'},{repoId:'x'},{purpose:'creator-claim-review'},{expiresAt:Date.now()-1},{githubUserId:'99'}]) assert.throws(()=>readBuilderReview(seal({...review,...patch}),session))
  const snapshot={repoId:'123',beneficiary:{wallet:'receiver',boundAt:review.boundAt},paid:'20'}
  assert.doesNotThrow(()=>assertClaimSnapshot(review,snapshot))
  assert.throws(()=>assertClaimSnapshot(review,{...snapshot,paid:'120'}))
  assert.throws(()=>assertClaimSnapshot(review,{...snapshot,beneficiary:{...snapshot.beneficiary,wallet:'other'}}))
})
test('queued reviews cap payouts to the reviewed amount even when newer fees arrive',()=>{
  assert.equal(reviewedClaimAmount({purpose:'builder-claim-review',amount:'100'},200n),100n)
  assert.throws(()=>reviewedClaimAmount({purpose:'builder-claim-review',amount:'100'},99n))
  assert.throws(()=>reviewedClaimAmount({purpose:'creator-claim-review',amount:'100'},200n))
  assert.equal(reviewedClaimAmount(undefined,200n),200n)
})
test('claim-all deduplicates repositories, limits concurrency, keeps partial results, and never blindly retries',async()=>{
  let active=0,max=0;const calls=[],events=[]
  const items=[1,2,3,1].map(id=>({repoId:String(id)}))
  const results=await claimBuilderQueue(items,async item=>{
    calls.push(item.repoId);active++;max=Math.max(max,active)
    await new Promise(resolve=>setTimeout(resolve,10));active--
    if(item.repoId==='2')throw new Error('network dropped after submission')
    return {status:'settled',signature:`sig-${item.repoId}`,amount:'100'}
  },(id,result)=>events.push([id,result.status]))
  assert.equal(max,2);assert.deepEqual(calls,['1','2','3']);assert.equal(results[1].status,'unknown');assert.equal(results.filter(x=>x.status==='settled').length,2)
  assert.equal(events.filter(x=>x[1]==='pending').length,3)
})
