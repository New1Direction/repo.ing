import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { createTrendSources } from './trend-sources.mjs'
import { TREND_INTERVAL_MS, trendScore, assertFreshTrend, transitionTrend, manualSignal, DAY } from './trend-rules.mjs'
import { DISCOVERY_VERSION, DISCOVERY_WINDOW_MS } from './discovery-rewards.mjs'
import { createMarketConfigResolver } from './market-config.mjs'
import { releaseAfterUnlock } from './database-pool.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const trendError = error => /^[A-Z_]{3,60}$/.test(error?.message??'') ? error.message : 'TREND_SOURCE_UNAVAILABLE'
const candidateSQL = `select c.github_repo_id::text as "repoId",c.full_name as "fullName",c.description,c.state,c.revision,
  c.observed_at as "observedAt",c.detected_at as "detectedAt",c.error,c.approved_config as "approvedConfig",
  c.approved_discovery_version as "approvedDiscoveryVersion",c.approved_window_ms::text as "approvedWindowMs",c.approved_at as "approvedAt",
  m.mint,m.status as "marketStatus",m.indexed_at as "indexedAt",m.launch_finality as "launchFinality",m.launcher_wallet as wallet,m.launch_block_time as "launchedAt",
  exists(select 1 from repositories r where r.github_repo_id=c.github_repo_id) as "repoIndexed"
  from trend_candidates c left join markets m on m.github_repo_id=c.github_repo_id`

const OBSERVATION_LIMIT = 100, SIGNAL_LIMIT = 100
const signalColumns = `source,url,note,occurred_at as "occurredAt",expires_at as "expiresAt",detected_at as "detectedAt",operator`

// observations: evidence JSON strings, newest first; signals: trend_signals rows, newest first.
function trendCandidateView(candidate, observations, signals, now) {
  let ready=true,reason=null
  try{assertFreshTrend(candidate,now)}catch(error){ready=false;reason=trendError(error)}
  if(candidate.marketStatus&&candidate.marketStatus!=='failed'){ready=false;reason='MARKET_ALREADY_EXISTS'}
  return {...candidate,signals,score:trendScore(observations.map(evidence=>JSON.parse(evidence)),signals,now),
    latestObservation:observations[0]?JSON.parse(observations[0]):null,
    ready:ready&&candidate.state==='approved',reason:reason??(candidate.state==='approved'?null:'OPERATOR_REVIEW_REQUIRED')}
}

export async function trendCandidate(db, repoId, now=Date.now()) {
  const {rows:[candidate]} = await db.query(`${candidateSQL} where c.github_repo_id=$1`,[repoId])
  if(!candidate)return null
  const {rows:observations}=await db.query(`select evidence from trend_observations where github_repo_id=$1 order by observed_at desc limit ${OBSERVATION_LIMIT}`,[repoId])
  const {rows:signals}=await db.query(`select ${signalColumns}
    from trend_signals where github_repo_id=$1 order by occurred_at desc,id desc limit ${SIGNAL_LIMIT}`,[repoId])
  return trendCandidateView(candidate,observations.map(o=>o.evidence),signals,now)
}

// The same view as trendCandidate for many candidates in three queries (not three per candidate): the public explore,
// find-repos and search surfaces read up to 200 candidates per refresh.
async function trendCandidates(db, repoIds, now) {
  if(!repoIds.length)return []
  const [{rows:candidates},{rows:observations},{rows:signals}]=await Promise.all([
    db.query(`${candidateSQL} where c.github_repo_id=any($1::bigint[])`,[repoIds]),
    db.query(`select ids.id::text as "repoId",o.evidence from unnest($1::bigint[]) as ids(id)
      cross join lateral (select evidence,observed_at from trend_observations where github_repo_id=ids.id
        order by observed_at desc limit ${OBSERVATION_LIMIT}) o order by ids.id,o.observed_at desc`,[repoIds]),
    db.query(`select ids.id::text as "repoId",s.* from unnest($1::bigint[]) as ids(id)
      cross join lateral (select id as "signalId",${signalColumns} from trend_signals where github_repo_id=ids.id
        order by occurred_at desc,id desc limit ${SIGNAL_LIMIT}) s order by ids.id,s."occurredAt" desc,s."signalId" desc`,[repoIds]),
  ])
  const evidence=new Map(),signalRows=new Map()
  const add=(map,key,value)=>{const list=map.get(key);if(list)list.push(value);else map.set(key,[value])}
  for(const {repoId,evidence:value} of observations)add(evidence,repoId,value)
  for(const {repoId,signalId,...signal} of signals)add(signalRows,repoId,signal)
  const byId=new Map(candidates.map(candidate=>[candidate.repoId,candidate]))
  return repoIds.flatMap(id=>byId.has(id)?[trendCandidateView(byId.get(id),evidence.get(id)??[],signalRows.get(id)??[],now)]:[])
}
async function recordSignal(db,repoId,signal,operator=null){
  await db.query(`insert into trend_signals(github_repo_id,source,url,note,occurred_at,expires_at,operator) values($1,$2,$3,$4,$5,$6,$7)
    on conflict(github_repo_id,source,url) do update set note=excluded.note,occurred_at=excluded.occurred_at,expires_at=excluded.expires_at
    where trend_signals.source <> 'manual'`,[repoId,signal.source,signal.url,signal.note,signal.occurredAt,signal.expiresAt,operator])
}
async function recordObservation(db,observation,signals,operator=null){
  const r=observation.repo
  await db.query('begin')
  try{
    await db.query(`insert into trend_candidates(github_repo_id,full_name,description,observed_at) values($1,$2,$3,$4)
      on conflict(github_repo_id) do update set full_name=excluded.full_name,description=excluded.description,
      observed_at=excluded.observed_at,attempted_at=now(),error=null`,[r.id,r.fullName,r.description,observation.observedAt])
    await db.query(`insert into trend_observations(github_repo_id,observed_at,evidence,evidence_hash) values($1,$2,$3,$4)
      on conflict(github_repo_id,observed_at) do nothing`,[r.id,observation.observedAt,JSON.stringify(observation),hash(observation)])
    for(const signal of signals)await recordSignal(db,r.id,signal,operator)
    await db.query('commit')
  }catch(error){await db.query('rollback');throw error}
}

export function createTrendIntake({pool,sources=createTrendSources(),now=()=>Date.now()}={}){
  async function runOnce(){
    const db=await pool.connect()
    try{
      if(!(await db.query("select pg_try_advisory_lock(hashtextextended('trend-intake',0)) as locked")).rows[0].locked)return {status:'BUSY'}
      const last=(await db.query("select checked_at from trend_source_health where source='intake'")).rows[0]
      if(last&&now()-last.checked_at.getTime()<TREND_INTERVAL_MS)return {status:'WAITING'}
      // Persist the attempt before I/O so restarting a worker cannot amplify API calls.
      await health(db,{source:'intake',status:'RUNNING',count:0})
      const seed=await sources.seeds()
      for(const row of seed.health)await health(db,row)
      const {rows:known}=await db.query(`select github_repo_id::text as "repoId",full_name as "fullName",state
        from (select * from trend_candidates where state not in ('rejected','duplicate')
          order by (state='approved') desc,detected_at desc,github_repo_id limit 32) watched order by attempted_at,github_repo_id`)
      const {rows:all}=await db.query('select github_repo_id::text as id,full_name as name from trend_candidates')
      const names=new Set(all.map(c=>c.name.toLowerCase()))
      const fresh=[...new Map(seed.signals.filter(s=>!names.has(s.repository.slice(19).toLowerCase())).map(s=>[s.repository,s])).values()]
      const picked=known.length?[...known.slice(0,4).map(c=>({repository:`https://github.com/${c.fullName}`,expectedId:c.repoId})),
        ...(fresh.length?fresh.slice(0,5-Math.min(4,known.length)):known.slice(4,5).map(c=>({repository:`https://github.com/${c.fullName}`,expectedId:c.repoId})))]:fresh.slice(0,5)
      const results=[]
      for(const item of picked){
        try{
          const observation=await sources.observe(item.repository,item.expectedId)
          if(item.expectedId&&observation.repo.id!==item.expectedId)throw Error('SOURCE_IDENTITY_DISAGREEMENT')
          const signals=seed.signals.filter(s=>s.repository.toLowerCase()===`https://github.com/${observation.repo.fullName}`.toLowerCase())
          if(signals.some(s=>s.expectedId&&s.expectedId!==observation.repo.id))throw Error('SOURCE_IDENTITY_DISAGREEMENT')
          await recordObservation(db,observation,signals)
          results.push({repoId:observation.repo.id,status:'OBSERVED'})
        }catch(error){
          const code=trendError(error)
          if(item.expectedId)await db.query('update trend_candidates set error=$2,attempted_at=now() where github_repo_id=$1',[item.expectedId,code])
          results.push({repository:item.repository,status:'UNAVAILABLE',code})
        }
      }
      await syncTrendLaunches(db)
      await health(db,{source:'intake',status:results.some(r=>r.status!=='OBSERVED')?'PARTIAL':'OK',count:results.filter(r=>r.status==='OBSERVED').length,results})
      return {status:'COMPLETE',results,sources:seed.health}
    }finally{await releaseAfterUnlock(db,()=>db.query("select pg_advisory_unlock(hashtextextended('trend-intake',0))"))}
  }
  async function addManual(input,operator){
    const signal=manualSignal(input,now())
    const observation=await sources.observe(signal.repository)
    const db=await pool.connect()
    try{await recordObservation(db,observation,[signal],operator);await syncTrendLaunches(db);return {repoId:observation.repo.id}}
    finally{db.release()}
  }
  return {runOnce,addManual}
}
async function health(db,row){
  await db.query(`insert into trend_source_health(source,status,detail) values($1,$2,$3)
    on conflict(source) do update set status=excluded.status,checked_at=now(),detail=excluded.detail`,[row.source,row.status,JSON.stringify(row)])
}

export async function reviewTrend({pool,repoId,to,revision,operator,config,discoveryEnabled,resolve}){
  if(!/^[1-9]\d*$/.test(String(repoId))||!Number.isInteger(revision))throw Error('INVALID_REPOSITORY_ID')
  const db=await pool.connect()
  try{
    await db.query('begin')
    const {rows:[locked]}=await db.query('select revision from trend_candidates where github_repo_id=$1 for update',[repoId])
    if(!locked||locked.revision!==revision)throw Error('REVIEW_CHANGED_RELOAD')
    const candidate=await trendCandidate(db,repoId)
    transitionTrend(candidate.state,to)
    if(['reviewed','approved'].includes(to) && !(to==='reviewed'&&candidate.state==='approved')){
      assertFreshTrend(candidate)
      if(candidate.marketStatus&&candidate.marketStatus!=='failed')throw Error('MARKET_ALREADY_EXISTS')
      if(to==='approved'){
        const resolved=await resolve(`https://github.com/${candidate.fullName}`)
        if(String(resolved.githubRepoId)!==repoId||resolved.fullName!==candidate.fullName)throw Error('SOURCE_IDENTITY_DISAGREEMENT')
        if(!discoveryEnabled)throw Error('DISCOVERY_ENROLLMENT_UNAVAILABLE')
        new PublicKey(config)
      }
    }
    await db.query(`update trend_candidates set state=$2,revision=revision+1,approved_config=$3,approved_discovery_version=$4,
      approved_window_ms=$5,approved_at=$6 where github_repo_id=$1`,[repoId,to,to==='approved'?config:null,
      to==='approved'?DISCOVERY_VERSION:null,to==='approved'?String(DISCOVERY_WINDOW_MS):null,to==='approved'?new Date():null])
    await db.query(`insert into trend_reviews(github_repo_id,from_state,to_state,operator,evidence) values($1,$2,$3,$4,$5)`,
      [repoId,candidate.state,to,operator,JSON.stringify({revision,config:to==='approved'?config:null,score:candidate.score,observation:candidate.latestObservation,signals:candidate.signals})])
    await db.query('commit');return {state:to}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
}

// Called within the existing canonical launch lock, twice: before requesting
// the wallet signature and after it returns, before any submission.
export function trendLaunchGuard({pool,repoId,revision,config,discoveryEnabled}){
  return async({repo,market,stage})=>{
    const candidate=await trendCandidate(pool,repoId)
    if(!candidate||String(repo.githubRepoId)!==repoId||candidate.fullName!==repo.fullName)throw Error('SOURCE_IDENTITY_DISAGREEMENT')
    assertFreshTrend(candidate)
    if(candidate.state!=='approved'||candidate.revision!==revision)throw Error('TREND_APPROVAL_REQUIRED')
    if(candidate.approvedConfig!==config)throw Error('LAUNCH_CONFIG_MISMATCH')
    if(!discoveryEnabled||candidate.approvedDiscoveryVersion!==DISCOVERY_VERSION||
      candidate.approvedWindowMs!==String(DISCOVERY_WINDOW_MS)||market.discoveryVersion!==DISCOVERY_VERSION)throw Error('DISCOVERY_PERIOD_MISMATCH')
    if(!market.launcherWallet||new PublicKey(market.launcherWallet).toBase58()!==market.launcherWallet)throw Error('DISCOVERER_ATTRIBUTION_MISSING')
    if(createMarketConfigResolver(config,[])(market).toBase58()!==config)throw Error('LAUNCH_CONFIG_MISMATCH')
    if(stage==='prepare')await pool.query(`insert into trend_launches(mint,github_repo_id,wallet,config,candidate_revision,evidence)
      values($1,$2,$3,$4,$5,$6)`,[market.mint,repoId,market.launcherWallet,config,revision,
        JSON.stringify({score:candidate.score,observationHash:hash(candidate.latestObservation),approvedAt:candidate.approvedAt,discoveryVersion:DISCOVERY_VERSION,windowMs:DISCOVERY_WINDOW_MS})])
    else{
      const {rows:[intent]}=await pool.query('select * from trend_launches where mint=$1',[market.mint])
      if(!intent||String(intent.github_repo_id)!==repoId||intent.wallet!==market.launcherWallet||intent.config!==config||intent.candidate_revision!==revision)throw Error('LAUNCH_ATTRIBUTION_MISMATCH')
    }
  }
}

export async function syncTrendLaunches(db){
  const {rows}=await db.query(`select c.github_repo_id::text as "repoId",c.state,m.status,m.indexed_at,m.launch_finality,m.launch_block_time,
    m.launcher_wallet,m.discovery_version,m.mint,m.pool,l.wallet,l.config,l.evidence,
    exists(select 1 from trade_events t where t.pool=m.pool) as traded
    from trend_candidates c join markets m on m.github_repo_id=c.github_repo_id left join trend_launches l on l.mint=m.mint
    where c.state <> 'active'`)
  for(const row of rows){
    let next=row.state,error=null
    if(row.status==='failed')continue
    if(!row.wallet){if(row.state!=='rejected'&&['confirmed','submitted','ambiguous'].includes(row.status))next='duplicate'}
    else if(row.status==='confirmed'&&row.indexed_at&&row.launch_finality==='finalized'){
      try{
        const evidence=JSON.parse(row.evidence)
        if(row.wallet!==row.launcher_wallet||row.discovery_version!==evidence.discoveryVersion||
          evidence.windowMs!==DISCOVERY_WINDOW_MS||!row.launch_block_time)throw Error('DISCOVERY_ATTRIBUTION_MISMATCH')
        createMarketConfigResolver(row.config,[])(row)
        next=row.traded?'active':'launched'
      }catch{error='DISCOVERY_ATTRIBUTION_MISMATCH'}
    }
    if(error)await db.query('update trend_candidates set error=$2 where github_repo_id=$1',[row.repoId,error])
    if(next!==row.state&&!error){
      await db.query('begin')
      try{
        // A first buy may already be indexed when the observer returns. Retain
        // both durable transitions rather than skipping the launch evidence.
        const path=next==='active'&&row.state!=='launched'?['launched','active']:[next]
        let from=row.state
        for(const state of path){
          const {rowCount}=await db.query('update trend_candidates set state=$2,revision=revision+1 where github_repo_id=$1 and state=$3',[row.repoId,state,from])
          if(!rowCount)break
          await db.query(`insert into trend_reviews(github_repo_id,from_state,to_state,operator,evidence) values($1,$2,$3,'worker',$4)`,
            [row.repoId,from,state,JSON.stringify({mint:row.mint,finality:row.launch_finality,tradeObserved:row.traded})])
          from=state
        }
        await db.query('commit')
      }catch(error){await db.query('rollback');throw error}
    }
  }
}

export async function trendOperatorView(pool,now=Date.now()){
  const [{rows:ids},{rows:sources}]=await Promise.all([
    pool.query('select github_repo_id::text as id from trend_candidates order by detected_at desc limit 200'),
    pool.query('select source,status,checked_at as "checkedAt",detail from trend_source_health order by source')])
  const candidates=await trendCandidates(pool,ids.map(row=>row.id),now)
  candidates.sort((a,b)=>b.score.total-a.score.total||(BigInt(a.repoId)<BigInt(b.repoId)?-1:1))
  return {checkedAt:new Date().toISOString(),candidates,sources:sources.map(s=>({...s,detail:JSON.parse(s.detail)}))}
}
