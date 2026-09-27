import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { trendScore,commitActivity,assertFreshTrend,assertTrendIdentity,transitionTrend,manualSignal,DAY } from '../src/trend-rules.mjs'
import { createTrendSources } from '../src/trend-sources.mjs'
import { discovererAttribution } from '../src/discoverer-growth.mjs'
const now=Date.parse('2026-09-26T12:00:00Z'),iso=t=>new Date(t).toISOString()
const repo={id:123,full_name:'owner/repo',owner:{login:'owner'},name:'repo',private:false,archived:false,stargazers_count:500,forks_count:10}
test('score uses actual intervals, decomposes exactly, and warms up without invented velocity',()=>{
  const signals=[{source:'hn',url:'hn:1',occurredAt:iso(now-1000),expiresAt:iso(now+DAY)},{source:'hn',url:'hn:1',occurredAt:iso(now-1000),expiresAt:iso(now+DAY)},
    {source:'manual',url:'x:1',occurredAt:iso(now-1000),expiresAt:iso(now+DAY)},{source:'github_trending',occurredAt:iso(now-1000),expiresAt:iso(now+DAY)}]
  const current={observedAt:iso(now),stars:1200,forks:22,releaseAt:iso(now-DAY),activity:{complete:true,currentCommits:10,previousCommits:2,currentContributors:5,previousContributors:1}}
  const baseline=trendScore([current],signals,now);assert.equal(baseline.parts.stars,0);assert.equal(baseline.parts.forks,0);assert.equal(baseline.inputs.mentions,1);assert.equal(baseline.warmingUp,true)
  const score=trendScore([current,{observedAt:iso(now-DAY/2),stars:1000,forks:12},{observedAt:iso(now-DAY),stars:980,forks:10}],signals,now)
  assert.equal(score.inputs.stars.delta,200);assert.equal(score.inputs.stars.perDay,400);assert.equal(score.parts.starAcceleration,10)
  assert.equal(score.total,88);assert.equal(score.total,Object.values(score.parts).reduce((a,b)=>a+b,0))
  assert.equal(trendScore([current],signals.map(s=>({...s,expiresAt:iso(now-1)})),now).parts.mentions,0)
  assert.equal(trendScore([{...current,stars:1},{observedAt:iso(now-DAY),stars:3,forks:24}],[],now).parts.stars,0)
})
test('activity compares complete adjacent windows and rejects truncation',()=>{
  const commits=[{author:{id:1},commit:{committer:{date:iso(now-10000)}}},{author:{id:1},commit:{committer:{date:iso(now-20000)}}},
    {author:{id:2},commit:{committer:{date:iso(now-DAY-10000)}}}]
  assert.deepEqual(commitActivity(commits,true,now),{complete:true,currentCommits:2,previousCommits:1,currentContributors:1,previousContributors:1,from:iso(now-2*DAY),to:iso(now)})
  assert.deepEqual(commitActivity(commits,false,now),{complete:false})
})
test('identity, stale source, manual source and state boundaries fail closed',()=>{
  assert.equal(assertTrendIdentity(repo,'123').id,123)
  for(const value of [{...repo,id:124},{...repo,private:true},{...repo,archived:true},{...repo,full_name:'different/repo'}])assert.throws(()=>assertTrendIdentity(value,'123'))
  assert.throws(()=>assertFreshTrend({observedAt:iso(now-7*3600000)},now),/STALE/)
  assert.throws(()=>assertFreshTrend({observedAt:iso(now),error:'SOURCE_IDENTITY_DISAGREEMENT'},now),/DISAGREEMENT/)
  assert.equal(transitionTrend('detected','reviewed'),'reviewed')
  assert.throws(()=>transitionTrend('detected','approved'));assert.throws(()=>transitionTrend('approved','active'))
  const manual={repositoryUrl:'https://github.com/owner/repo',sourceUrl:'https://x.com/user/status/123',note:'Public narrative evidence',occurredAt:iso(now-1000)}
  assert.equal(manualSignal(manual,now).source,'manual')
  assert.throws(()=>manualSignal({...manual,sourceUrl:'javascript:alert(1)'},now))
  assert.throws(()=>manualSignal({...manual,occurredAt:iso(now-8*DAY)},now))
})
test('source adapters validate identity and disclose incomplete commit windows',async()=>{
  const urls=[]
  const sources=createTrendSources({now:()=>now,pause:async()=>{},fetchImpl:async url=>{urls.push(url);return new Response(JSON.stringify(url.includes('/commits?')?[]:url.endsWith('/releases/latest')?{published_at:iso(now-DAY),html_url:'https://github.com/owner/repo/releases/tag/v1'}:repo),{headers:url.includes('/commits?')?{link:'<next>; rel="next"'}:{}})}})
  const observed=await sources.observe('https://github.com/owner/repo','123')
  assert.equal(observed.repo.id,'123');assert.equal(observed.activity.complete,false)
  urls.length=0;await sources.observe('https://github.com/owner/repo')
  assert.deepEqual(urls.slice(0,2),['https://api.github.com/repos/owner/repo','https://api.github.com/repositories/123'])
  const bad=createTrendSources({now:()=>now,pause:async()=>{},fetchImpl:async url=>new Response(JSON.stringify({...repo,id:url.includes('/repositories/')?123:124}))})
  await assert.rejects(()=>bad.observe('https://github.com/owner/repo','123'),/VERIFIED/)
})
test('reward attribution reuses cap/window, excludes later trades, and rejects wrong wallets or evidence',()=>{
  const market={wallet:Keypair.generate().publicKey.toBase58(),signature:'finalized-receipt',finality:'finalized',indexedAt:iso(now),launchedAt:iso(now-DAY),version:2,pool:'pool'}
  const event={pool:'pool',partnerAmount:'100',slot:'1',eventIndex:0,tradedAt:iso(now),quoteAmount:'10000'}
  const result=discovererAttribution(market,[event],[{wallet:market.wallet,amount:'20'}])
  assert.equal(result.earned,'50');assert.equal(result.paid,'20');assert.equal(result.rewardVolume,'10000')
  assert.equal(discovererAttribution(market,[event],[],[event,{...event,slot:'2',quoteAmount:'1'}]).rewardVolume,'10001','zero partner-fee rounding does not erase real trade volume')
  assert.equal(discovererAttribution(market,[{...event,partnerAmount:'6000000000'}],[],[{...event,signature:'a'},{...event,signature:'b'}]).rewardVolume,null,'cap crossing without transaction ordering does not invent volume')
  assert.throws(()=>discovererAttribution(market,[{...event,tradedAt:iso(now+29*DAY)}],[]),/PERIOD/)
  assert.throws(()=>discovererAttribution(market,[{...event,pool:'wrong'}],[]),/PERIOD/)
  assert.throws(()=>discovererAttribution(market,[{...event,quoteAmount:null}],[]),/EVIDENCE/)
  assert.throws(()=>discovererAttribution(market,[event],[{wallet:'other',amount:'1'}]),/WALLET/)
  assert.throws(()=>discovererAttribution(market,[event],[{wallet:market.wallet,amount:'51'}]),/SETTLEMENT/)
  assert.equal(discovererAttribution({...market,version:1},[{...event,partnerAmount:'3000000000'}],[]).earned,'1000000000')
  assert.equal(discovererAttribution(market,[{...event,partnerAmount:'6000000000'},{...event,slot:'2',quoteAmount:'99999'}],[]).rewardVolume,'10000')
})
