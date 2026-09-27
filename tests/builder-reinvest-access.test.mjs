import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {encryptGithubSession} from '../app/lib/auth.mjs'
import * as route from '../app/api/reinvest/[repo]/route.js'
import {assertBuilderReinvestEnabled} from '../src/builder-reinvest.mjs'

test('P4 HTTP boundary rejects unauthenticated, wrong-repository, cross-origin and disabled execution',async t=>{
  const old={...process.env}
  t.after(()=>{for(const key of ['GITHUB_APP_CLIENT_SECRET','APP_ORIGIN','BUILDER_REINVEST_ENABLED']){
    if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]
  }})
  process.env.GITHUB_APP_CLIENT_SECRET=randomBytes(32).toString('hex')
  process.env.APP_ORIGIN='https://repo.ing';process.env.BUILDER_REINVEST_ENABLED='false'
  const session=repoId=>encryptGithubSession({repoId,permission:'admin',githubUserId:'123',accessToken:'ghu_test_only',sessionId:randomBytes(24).toString('hex'),expiresAt:Date.now()+60000})
  const make=(cookie,origin='https://repo.ing',body={action:'prepare'})=>({url:'https://repo.ing/api/reinvest/1',headers:new Headers({origin}),cookies:{get:()=>cookie?{value:cookie}:undefined},json:async()=>body})
  const context={params:Promise.resolve({repo:'1'})}
  for(const method of ['GET','POST'])for(const cookie of [undefined,session('2')]){
    const response=await route[method](make(cookie),context)
    assert.equal(response.status,403);assert.match(response.headers.get('cache-control'),/no-store/)
  }
  assert.equal((await route.POST(make(session('1'),'https://evil.invalid'),context)).status,403)
  assert.equal((await route.POST(make(session('1')),context)).status,403)
  assert.equal((await route.GET(make(session('1')),context)).status,200)
  assert.equal((await (await route.GET(make(session('1')),context)).json()).enabled,false)
  assert.equal((await route.POST(make(session('1'),'https://repo.ing',{action:'prepare',pool:'wrong'}),context)).status,403)
})

test('P4 mainnet gate requires real bounded P3 evidence, not an empty MATCH',async()=>{
  const connection={rpcEndpoint:'https://primary.invalid',getGenesisHash:async()=> '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'}
  const verification={...connection,rpcEndpoint:'https://secondary.invalid'}
  const env={BUILDER_REINVEST_ENABLED:'true',BUILDER_REINVEST_P3_SIGNATURE:'not-a-real-proof',NODE_ENV:'production'}
  await assert.rejects(assertBuilderReinvestEnabled({connection,verification,env,pool:{query:async()=>({rows:[]})}}),/bounded live proof/)
  await assert.rejects(assertBuilderReinvestEnabled({connection,verification,env,pool:{query:async()=>({rows:[{settled_debit:'1',source_amount:'50000001',max_network_cost:'12000000'}]})}}),/bounded live proof/)
  await assert.rejects(assertBuilderReinvestEnabled({connection,verification,env,pool:{query:async()=>({rows:[{settled_debit:'1',source_amount:'50000000',max_network_cost:'12000001'}]})}}),/bounded live proof/)
  await assert.rejects(assertBuilderReinvestEnabled({connection,verification:connection,env}),/independent RPC/)
})

test('fresh quotes use the reviewed output/LP floors without applying slippage twice',async()=>{
  const {assertFreshReinvestQuote}=await import('../src/builder-reinvest-chain.mjs')
  const terms={min_swap_output:'990',minimum_liquidity:'495'}
  assert.doesNotThrow(()=>assertFreshReinvestQuote(terms,{outputAmount:'995',minA:'985',liquidity:'496'}))
  assert.throws(()=>assertFreshReinvestQuote(terms,{outputAmount:'989',minA:'980',liquidity:'500'}),/Stale quote/)
  assert.throws(()=>assertFreshReinvestQuote(terms,{outputAmount:'1000',minA:'990',liquidity:'494'}),/Stale quote/)
})
