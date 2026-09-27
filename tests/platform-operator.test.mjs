import test from 'node:test'
import assert from 'node:assert/strict'
import { requirePlatformOperator } from '../app/lib/platform-operator.mjs'
import { randomBytes } from 'node:crypto'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import * as liquidity from '../app/api/platform-liquidity/route.js'
import * as revenue from '../app/api/platform-revenue/route.js'
import * as fees from '../app/api/platform-fees/[repo]/route.js'
import * as trends from '../app/api/operations/trends/route.js'
test('builder access never grants platform treasury access without the immutable-ID allowlist',()=>{
  const session={scope:'builders',githubUserId:'123',expiresAt:Date.now()+60000}
  assert.throws(()=>requirePlatformOperator(null,{}),e=>e.status===401)
  assert.throws(()=>requirePlatformOperator({...session,expiresAt:0},{PLATFORM_OPERATOR_GITHUB_IDS:'123'}),e=>e.status===401)
  assert.throws(()=>requirePlatformOperator({...session,expiresAt:undefined},{PLATFORM_OPERATOR_GITHUB_IDS:'123'}),e=>e.status===401)
  assert.throws(()=>requirePlatformOperator(session,{}),e=>e.status===403)
  assert.throws(()=>requirePlatformOperator(session,{PLATFORM_OPERATOR_GITHUB_IDS:'124'}),e=>e.status===403)
  assert.throws(()=>requirePlatformOperator(session,{PLATFORM_OPERATOR_GITHUB_IDS:'123,not-an-id'}),e=>e.status===403)
  assert.equal(requirePlatformOperator(session,{PLATFORM_OPERATOR_GITHUB_IDS:'123,456'}),session)
})

test('all treasury HTTP routes reject unauthenticated and non-operator builder sessions before accessing funds',async t=>{
  const previous={secret:process.env.GITHUB_APP_CLIENT_SECRET,operators:process.env.PLATFORM_OPERATOR_GITHUB_IDS,origin:process.env.APP_ORIGIN}
  t.after(()=>{for(const [key,value] of Object.entries({GITHUB_APP_CLIENT_SECRET:previous.secret,PLATFORM_OPERATOR_GITHUB_IDS:previous.operators,APP_ORIGIN:previous.origin})){
    if(value===undefined)delete process.env[key];else process.env[key]=value
  }})
  process.env.GITHUB_APP_CLIENT_SECRET=randomBytes(32).toString('hex')
  process.env.PLATFORM_OPERATOR_GITHUB_IDS='123'
  process.env.APP_ORIGIN='https://repo.ing'
  const builder=encryptGithubSession({scope:'builders',repoId:null,permission:'identity',githubUserId:'456',
    accessToken:'ghu_test_only',sessionId:randomBytes(24).toString('hex'),expiresAt:Date.now()+60000})
  for(const route of [liquidity,revenue,fees,trends])for(const method of ['GET','POST'])for(const [cookie,status] of [[undefined,401],[builder,403]]){
    const request={url:'https://repo.ing/api/platform-liquidity',headers:new Headers({origin:'https://repo.ing'}),
      cookies:{get:()=>cookie?{value:cookie}:undefined},json:async()=>({action:'intent.execute',id:1})}
    const response=await route[method](request,{params:Promise.resolve({repo:'996001'})})
    assert.equal(response.status,status)
    assert.match(response.headers.get('cache-control'),/no-store/)
  }
})
