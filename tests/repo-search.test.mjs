import test from 'node:test'
import assert from 'node:assert/strict'
import { publicTrendCandidates } from '../src/public-trends.mjs'
import { normalizeSearch, searchRepositoryUrl, simpleSearch, searchQuestions, interpretSearchResponse, applySearchResult } from '../src/repo-search.mjs'
import { createRepoSearch, readSearchJson } from '../src/jev-repo-search.mjs'

const now = Date.now()
const candidate = (id, changes = {}) => ({ repoId: String(id), fullName: `project/repo-${id}`, description: 'An AI coding agent',
  state: 'detected', error: null, observedAt: new Date(now).toISOString(), revision: 0, ready: false,
  marketStatus: null, indexedAt: null, launchFinality: null, approvedConfig: null,
  latestObservation: { stars: 120, forks: 3 },
  score: { total: 25, parts: { stars: 15, release: 10 }, inputs: { stars: { delta: 20, hours: 2, perDay: 240 }, releaseAt: new Date(now-86400000).toISOString() } },
  signals: [{ source: 'github_trending', url: 'https://github.com/trending', note: 'Seen on Trending', expiresAt: new Date(now+3600000).toISOString(), operator: 'private' }, { source: 'manual', note: 'Private operator comment' }],
  ...changes })
const candidates = publicTrendCandidates([candidate(1), candidate(2, { description: 'A spreadsheet editor', marketStatus: 'confirmed', indexedAt: new Date(now), launchFinality: 'finalized', mint: 'public-mint' })], { now })
function answer(choice, choices, confidence = 0.96) { return { type: 'choice', choice, confidence, probabilities: Object.fromEntries(choices.map(key => [key, key === choice ? 1 : 0])) } }
function response(overrides = {}) { return { answers: {
  supported: answer('yes',['yes','no']), market: answer('all',['all','unlaunched','live']), activity: answer('any',['any','stars','release']),
  repo_0: answer('match',['match','no','uncertain']), repo_1: answer('no',['match','no','uncertain']), ...overrides,
} } }
const enabled = { REPO_SMART_SEARCH_ENABLED: 'true', TYPESAFE_API_KEY: 'unit-test-only' }

test('public projection excludes stale, future, rejected and errored evidence; exposes no operator data', () => {
  const result = publicTrendCandidates([candidate(1), candidate(2,{observedAt:new Date(now-7*3600000).toISOString()}),
    candidate(3,{observedAt:new Date(now+120000).toISOString()}),candidate(4,{state:'rejected'}),candidate(5,{error:'SOURCE_IDENTITY_DISAGREEMENT'})], {now})
  assert.equal(result.length,1)
  assert.equal(JSON.stringify(result).includes('private'),false)
  assert.equal(JSON.stringify(result).includes('Private operator'),false)
  assert.equal(result[0].stars,120)
})
test('only finalized indexed markets are live; pending markets are never launchable or unlaunched', () => {
  const rows = publicTrendCandidates([candidate(1,{marketStatus:'confirmed',indexedAt:new Date(),launchFinality:'confirmed',ready:true,approvedConfig:'active'}),
    candidate(2,{state:'approved',ready:true,approvedConfig:'other'}),candidate(3,{state:'approved',ready:true,approvedConfig:'active'})], {now,config:'active'})
  assert.equal(rows[0].mint,null); assert.equal(rows[0].marketState,'pending'); assert.equal(rows[0].ready,false)
  assert.equal(rows[1].ready,false); assert.equal(rows[2].ready,true)
  assert.equal(applySearchResult({ids:['1'],filters:{market:'unlaunched',activity:'any'}},rows).length,0)
})
test('input bounds and direct repository URL shortcuts', () => {
  assert.equal(normalizeSearch('  AI   tools  '),'AI tools')
  assert.throws(()=>normalizeSearch('x'.repeat(181)))
  assert.throws(()=>normalizeSearch({query:'text'}))
  assert.equal(searchRepositoryUrl('New1Direction/repoing'),'https://github.com/New1Direction/repoing')
  assert.equal(searchRepositoryUrl('https://evil.test/name/repo'),null)
  assert.equal(searchRepositoryUrl('tools for coding'),null)
})
test('ordinary searches and activity shortcuts need no AI; unknown measurements never satisfy filters', () => {
  assert.deepEqual(simpleSearch('AI coding tools',candidates).ids,['1'])
  assert.deepEqual(simpleSearch('spreadsheet',candidates).ids,['2'])
  assert.deepEqual(applySearchResult(simpleSearch('live markets',candidates),candidates).map(c=>c.repoId),['2'])
  const rows = [candidates[0], {...candidates[1],score:{...candidates[1].score,inputs:{stars:null,releaseAt:null}}}]
  assert.deepEqual(applySearchResult(simpleSearch('repos gaining stars',rows),rows).map(c=>c.repoId),['1'])
  assert.deepEqual(applySearchResult(simpleSearch('recent releases',rows),rows).map(c=>c.repoId),['1'])
})
test('model only selects supplied identities; facts/filtering/order stay in code', () => {
  const input = response({repo_1:answer('match',['match','no','uncertain']),market:answer('unlaunched',['all','unlaunched','live'])})
  const result = interpretSearchResponse(input,candidates)
  assert.deepEqual(applySearchResult(result,candidates,now).map(c=>c.repoId),['1'])
  assert.equal(result.mode,'smart')
  const all = interpretSearchResponse(response({repo_1:answer('match',['match','no','uncertain'])}),candidates)
  assert.deepEqual(applySearchResult(all,candidates).map(c=>c.repoId),['1','2'])
  const payload=JSON.stringify(searchQuestions('AI tools',candidates))
  for(const absent of ['private','wallet','approvedConfig']) assert.equal(payload.includes(`"${absent}":`),false)
})
test('unsupported/uncertain interpretations ask for a narrower search; malformed answers fall back', () => {
  assert.equal(interpretSearchResponse(response({supported:answer('no',['yes','no'])}),candidates).mode,'clarify')
  assert.equal(interpretSearchResponse(response({market:answer('live',['all','unlaunched','live'],0.2)}),candidates).mode,'clarify')
  assert.deepEqual(interpretSearchResponse(response({repo_0:answer('match',['match','no','uncertain'],0.2)}),candidates).ids,[])
  assert.throws(()=>interpretSearchResponse(response({market:{type:'choice',choice:'send_funds',confidence:1}}),candidates))
  assert.throws(()=>interpretSearchResponse({answers:{}},candidates))
})
test('provider call is bounded and server-only; repeated queries share/cache interpretations, not current state', async () => {
  let calls=0, release
  const waiting=new Promise(resolve=>{release=resolve})
  const search=createRepoSearch({env:enabled,fetchImpl:async(url,init)=>{
    calls++; assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.redirect,'error')
    assert.equal(init.headers.Authorization,'Bearer unit-test-only');assert.ok(init.signal)
    await waiting;return Response.json(response())
  }})
  const a=search('AI coding tools that are new',candidates),b=search('AI coding tools that are new',candidates)
  release();assert.equal((await a).mode,'smart');await b
  await search('AI coding tools that are new',candidates);assert.equal(calls,1)
  await search('AI coding tools that are new',[{...candidates[0],description:'A different project'},candidates[1]]);assert.equal(calls,2)
  const changed=[{...candidates[0],marketState:'live'},candidates[1]]
  const result=await search('AI coding tools that are new',changed);assert.equal(calls,2)
  assert.equal(applySearchResult({...result,filters:{market:'unlaunched',activity:'any'}},changed).length,0)
})
test('no key, disabled gate, provider failures and rate budgets retain ordinary search', async () => {
  let calls=0
  const fail=async()=>{calls++;throw Error('secret provider detail')}
  for(const env of [{}, {...enabled,REPO_SMART_SEARCH_ENABLED:'false'}]) {
    const result=await createRepoSearch({env,fetchImpl:fail})('spreadsheet',candidates)
    assert.equal(result.mode,'keyword');assert.deepEqual(result.ids,['2'])
  }
  assert.equal(calls,0)
  const search=createRepoSearch({env:enabled,fetchImpl:fail})
  assert.equal((await search('spreadsheet',candidates)).mode,'keyword')
  await search('another query',candidates);assert.equal(calls,1)
  const limited=createRepoSearch({env:enabled,minuteLimit:0,fetchImpl:fail})
  await limited('spreadsheet',candidates);assert.equal(calls,1)
})
test('request and provider response byte limits reject oversized streams',async()=>{
  assert.deepEqual(await readSearchJson(Response.json({query:'AI tools'})),{query:'AI tools'})
  await assert.rejects(()=>readSearchJson(new Response('x'.repeat(3000))),/too large/)
  await assert.rejects(()=>readSearchJson(new Response('{}',{headers:{'Content-Length':'9000'}})),/Invalid/)
})
