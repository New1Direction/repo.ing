import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {graduationProgress,assertFreshGraduation,agreeGraduation,evidenceHash} from '../src/graduation-state.mjs'
import {firstP3Eligibility,publicGraduation,recordGraduationEvidence} from '../src/graduation-readiness.mjs'
import {liquidityConfig} from '../src/liquidity-deployment.mjs'
import {encryptGithubSession} from '../app/lib/auth.mjs'
import * as route from '../app/api/operations/graduation/route.js'

test('provider property ordering is irrelevant; balances and instruction ordering must still agree',()=>{
  const a={slot:1,transaction:{instructions:[{program:'dbc',accounts:[1,2]}]},balances:['100','200']}
  const b={balances:['100','200'],transaction:{instructions:[{accounts:[1,2],program:'dbc'}]},slot:1}
  assert.equal(agreeGraduation(a,b),a);assert.equal(evidenceHash(a),evidenceHash(b))
  assert.throws(()=>agreeGraduation(a,{...b,balances:['100','201']}),/RPC_DISAGREEMENT/)
  assert.throws(()=>agreeGraduation(a,{...b,transaction:{instructions:[{accounts:[2,1],program:'dbc'}]}}),/RPC_DISAGREEMENT/)
})

test('progress uses each actual threshold, exact integer remaining and never treats 100% as migration proof',()=>{
  assert.deepEqual(graduationProgress('63750000000','85000000000'),{phase:'CURVE',status:'active',reserveLamports:'63750000000',thresholdLamports:'85000000000',remainingLamports:'21250000000',progressPercent:75})
  assert.equal(graduationProgress('900000000','1000000000').progressPercent,90)
  assert.equal(graduationProgress('85000000000','85000000000').status,'migrating')
  assert.equal(graduationProgress('85000000000','85000000000').phase,'CURVE')
  assert.equal(graduationProgress('0','85000000000',true).phase,'GRADUATED')
  assert.throws(()=>graduationProgress('1','0'),/INVALID_THRESHOLD/)
  assert.throws(()=>graduationProgress('-1','85'),/INVALID_THRESHOLD/)
})
test('stale, unproven, disagreeing or unreconciled graduation is never public and internals stay private',()=>{
  const now=Date.now(),state={...graduationProgress('1','100'),checkedAt:new Date(now).toISOString(),chainTime:new Date(now-15000).toISOString(),platform:{available:'999'},p3:{eligible:true},migration:{signature:'private-operator-evidence'}}
  const row={status:'VERIFIED',observation:JSON.stringify(state),reconciliation:'{"status":"MATCH"}'}
  assert.equal(publicGraduation(row,now).platform,undefined);assert.equal(publicGraduation(row,now).p3,undefined)
  assert.equal(publicGraduation(row,now+130000).status,state.status)
  assert.throws(()=>publicGraduation(row,now+310000),/STALE_PROGRESS/)
  assert.throws(()=>assertFreshGraduation(state,now+130000),/STALE_PROGRESS/)
  assert.throws(()=>publicGraduation({...row,status:'REVIEW',error_code:'RPC_DISAGREEMENT'}),/RPC_DISAGREEMENT/)
  assert.throws(()=>publicGraduation({...row,observation:JSON.stringify({...state,phase:'GRADUATED'}),reconciliation:'{"status":"MISMATCH"}'}),/RECONCILIATION_MISMATCH/)
  assert.throws(()=>publicGraduation({...row,observation:JSON.stringify({...state,phase:'GRADUATED'})}),/MIGRATION_EVIDENCE_INCOMPLETE/)
  assert.throws(()=>assertFreshGraduation({...state,chainTime:new Date(now-121000).toISOString()},now),/STALE_PROGRESS/)
  assert.throws(()=>agreeGraduation({slot:1},{slot:2}),/RPC_DISAGREEMENT/)
})
test('first P3 readiness needs all evidence, claimed allocation, matching V1, operating SOL and strict caps',()=>{
  const rules=liquidityConfig({...JSON.parse(readFileSync('docs/P3_FIRST_LIVE_SETTINGS.json')),REPO_LIQUIDITY_EXECUTION_ENABLED:'true'})
  const state={phase:'GRADUATED',migration:{},checkedAt:new Date().toISOString(),chainTime:new Date().toISOString(),dammSolLamports:'85000000000'}
  const base={state,reconciliation:'MATCH',revenue:{activePolicy:{version:1,buybackPermille:600,liquidityPermille:200},claimed:{total:'250000000'},spent:'0',reconciliation:{status:'MATCH'}},reserve:{open:0,settled:'0',remaining:'50000000'},liquidity:{status:'MATCH'},rules,volume:'85000000000',walletBalance:'262000000'}
  assert.equal(firstP3Eligibility(base).eligible,true)
  for(const change of [{pendingClaims:1},{state:{...state,phase:'CURVE'}},{state:{...state,migration:null}},{reconciliation:'MISMATCH'},{rules:null},{rules:{...rules,maxDeployLamports:'50000001'}},{rules:{...rules,maxNetworkCostLamports:'12000001'}},{reserve:{...base.reserve,remaining:'0'}},{reserve:{...base.reserve,open:1}},{reserve:{...base.reserve,settled:'1'}},{walletBalance:'261999999'},{volume:'24999999999'},{state:{...state,dammSolLamports:'100000000000'}},{revenue:{...base.revenue,activePolicy:{version:2,buybackPermille:600,liquidityPermille:200}}}])assert.equal(firstP3Eligibility({...base,...change}).eligible,false,JSON.stringify(change))
  assert.equal(process.env.REPO_LIQUIDITY_EXECUTION_ENABLED,'false')
})
test('conflicting repeated migration proof is rejected without replacing the original event',async()=>{
  const state={repoId:'1',migration:{signature:'new',pool:'same',slot:1},migrationHash:'newhash'}
  let updates=0
  const db={query:async sql=>{if(sql.startsWith('insert')){updates++;assert.match(sql,/do nothing/);return {rows:[]}}return {rows:[{signature:'original',pool:'same',evidence_hash:'originalhash'}]}}}
  await assert.rejects(recordGraduationEvidence(db,state,null,{status:'MATCH'}),/DUPLICATE_GRADUATION_CONFLICT/)
  assert.equal(updates,1)
})
test('operations data and alert mutation require the configured operator and same-origin',async t=>{
  const names=['GITHUB_APP_CLIENT_SECRET','PLATFORM_OPERATOR_GITHUB_IDS','APP_ORIGIN'],old=Object.fromEntries(names.map(k=>[k,process.env[k]]))
  t.after(()=>{for(const k of names)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k]})
  process.env.GITHUB_APP_CLIENT_SECRET=randomBytes(32).toString('hex');process.env.PLATFORM_OPERATOR_GITHUB_IDS='123';process.env.APP_ORIGIN='https://repo.ing'
  const token=id=>encryptGithubSession({scope:'builders',repoId:null,permission:'identity',githubUserId:id,accessToken:'ghu_test_only',sessionId:randomBytes(24).toString('hex'),expiresAt:Date.now()+60000})
  const req=(cookie,origin='https://repo.ing')=>({url:'https://repo.ing/api/operations/graduation',headers:new Headers({origin}),cookies:{get:()=>cookie?{value:cookie}:undefined},json:async()=>({action:'execute',id:1})})
  assert.equal((await route.GET(req())).status,401)
  assert.equal((await route.GET(req(token('124')))).status,403)
  const denied=await route.POST(req(token('123'),'https://evil.invalid'));assert.equal(denied.status,400);assert.match(denied.headers.get('Cache-Control'),/no-store/)
  assert.equal((await route.POST(req(token('123')))).status,400,'readiness endpoint has no spending action')
})
