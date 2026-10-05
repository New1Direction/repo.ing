import { PublicKey } from '@solana/web3.js'
import { createReconciler, RECONCILE_HOLD_MS } from './reconcile.mjs'
import { createLedgerAlerts } from './ledger-alerts.mjs'
import { platformRevenueSummary, reconcilePlatformRevenue, assertPlatformReserveCustody } from './platform-revenue.mjs'
import { liquidityConfig, liquidityReserveSummary, reconcileLiquidity } from './liquidity-deployment.mjs'
import { createGraduatedFees } from './graduated-fees.mjs'
import { reinvestQuote } from './builder-reinvest-chain.mjs'
import { verifyLiquidityReceipt } from './liquidity-settlement.mjs'
import { indexDammTradesLocked } from './damm-trades.mjs'
import { createCurveReads, readGraduationState, assertFreshGraduation, PUBLIC_GRADUATION_MAX_AGE_MS, agreeGraduation, evidenceJSON, evidenceHash } from './graduation-state.mjs'
import { clearLedgerAlerts, persistGraduationObservation } from './reserve-alerts.mjs'
import { readGenesisHash, transientRpcReason } from './rpc-usage.mjs'
import { releaseAfterUnlock } from './database-pool.mjs'

// A thrown error as a review code. A message that already is a code is kept. Prose (web3.js wraps an RPC failure in its own
// message) is RPC_RATE_LIMITED or RPC_UNAVAILABLE when it names one or when transientRpcReason recognizes a transport failure
// (429, 5xx, a timeout, a dropped connection, a lagging node); any other prose is EVIDENCE_UNAVAILABLE, never transient.
export const graduationError = error => {
  const message = String(error?.message ?? '')
  if (/^[A-Z][A-Z_]{3,60}$/.test(message)) return message
  const reason = transientRpcReason(error)
  if (message.includes('RPC_RATE_LIMITED') || reason === 'rate limited' || reason === 'HTTP 429') return 'RPC_RATE_LIMITED'
  if (message.includes('RPC_UNAVAILABLE') || reason) return 'RPC_UNAVAILABLE'
  return 'EVIDENCE_UNAVAILABLE'
}
// SOL markets only; stock-paired markets graduate in src/stock-graduation-monitor.mjs (STOCK_MARKET_SQL is the other half).
// Contributor early access markets (transfer-hook pools, docs/EARLY_ACCESS.md) are in neither list until their graduation ships.
export const publicMarketSQL=`select m.github_repo_id::text as "githubRepoId",m.mint,m.pool,m.creator_wallet as "creatorWallet",r.full_name as "fullName"
  from markets m join repositories r on r.github_repo_id=m.github_repo_id where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.quote_asset_id is null and m.early_access_end is null`

export function firstP3Eligibility({state,reconciliation,revenue,reserve,liquidity,volume,rules,walletBalance,pendingClaims=0}) {
  const no=reason=>({eligible:false,reason})
  try{assertFreshGraduation(state)}catch{return no('Progress is stale or unavailable')}
  if(state.phase!=='GRADUATED'||!state.migration)return no('Awaiting verified graduation')
  if(reconciliation!=='MATCH'||revenue.reconciliation.status!=='MATCH'||liquidity.status!=='MATCH')return no('Reconciliation must MATCH')
  if(pendingClaims>0)return no('Resolve the pending platform claim first')
  if(!rules||BigInt(rules.maxDeployLamports)>50000000n||BigInt(rules.maxNetworkCostLamports)>12000000n||rules.maxSlippageBps>100||rules.maxPriceImpactBps>50||rules.rulesVersion!==1||BigInt(rules.minVolumeLamports)<25000000000n||BigInt(rules.targetSolLamports)>100000000000n)return no('First-live limits must be configured')
  const policy=revenue.activePolicy
  if(!policy||policy.version!==1||policy.buybackPermille!==600||policy.liquidityPermille!==200)return no('Approved V1 policy must be active')
  if(reserve.open!==0)return no('Resolve the existing liquidity intent first')
  if(BigInt(reserve.settled)>0n)return no('First deployment already completed; use its verification runbook')
  if(BigInt(volume)<BigInt(rules.minVolumeLamports))return no('DBC volume is below the qualification threshold')
  if(BigInt(state.dammSolLamports)>=BigInt(rules.targetSolLamports))return no('Pool already meets the liquidity target')
  const budget=BigInt(reserve.remaining)<BigInt(rules.maxDeployLamports)?BigInt(reserve.remaining):BigInt(rules.maxDeployLamports)
  if(budget<BigInt(rules.minDeployLamports)||budget<=0n)return no('Claimed and allocated liquidity reserve is required')
  const protectedFunds=BigInt(revenue.claimed.total)-BigInt(reserve.settled)-BigInt(revenue.spent)
  if(walletBalance===null||BigInt(walletBalance)<protectedFunds+BigInt(rules.maxNetworkCostLamports))return no('Separate operating SOL is required for overhead')
  return {eligible:true,reason:'Ready for operator review; execution remains manual',maximumInvestment:String(budget),maximumOverhead:rules.maxNetworkCostLamports}
}

const LEDGER_ALERT='RECONCILIATION_MISMATCH'
// Why a pass did not get through its markets, when it is no review code: fixed codes of the monitor's own, never a failure's
// message. Its own reads failed (readPassLedgers); it died between two markets; or passes come round less often than public
// progress lasts.
const LEDGER_READS_FAILED='LEDGER_READS_FAILED',MARKET_PASS_FAILED='MARKET_PASS_FAILED',PASS_TOO_SLOW='PASS_TOO_SLOW'
async function emitAlert(db,repoId,kind,key,detail) {
  const {rows}=await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing returning id,kind,github_repo_id::text as "repoId",created_at as "createdAt"`,[`${repoId??'protocol'}:${kind}:${key}`,repoId,kind,evidenceJSON(detail)])
  return rows[0]??null
}
export async function recordGraduationEvidence(db,state,previous,reconciliation) {
  if(!state.migration)return false
  const m=state.migration
  const {rows}=await db.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,previous_observation,reconciliation)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(github_repo_id) do nothing returning github_repo_id`,
    [state.repoId,m.signature,m.pool,m.slot,state.migrationHash,evidenceJSON({migration:m,positions:state.positionEvidence,postCurve:state.accountEvidence}),previous?.observation??null,evidenceJSON(reconciliation)])
  const {rows:[stored]}=await db.query('select signature,pool,evidence_hash from graduation_events where github_repo_id=$1',[state.repoId])
  if(stored.signature!==m.signature||stored.pool!==m.pool||stored.evidence_hash!==state.migrationHash)throw Error('DUPLICATE_GRADUATION_CONFLICT')
  return rows.length===1
}

// The pause between markets in a pass. Curve accounts are read in batches for the whole pass (createCurveReads), so each
// market adds only a few reads; the pause just spreads them. A pass is ~30 s + markets x (pause + ~0.5 s): keep it well under
// half of PUBLIC_GRADUATION_MAX_AGE_MS (300 s) at the market counts expected, so one failed pass never lets public state
// expire. 2 s per market made 51 markets take ~155 s, and ~108 markets would have reached the limit.
export const GRADUATION_MARKET_PAUSE_MS=500
// What a pass reads once for all its markets: the platform's ledgers and the markets themselves.
async function readPassLedgers(pool) {
  const [revenue,reserve,liquidity,revenueCheck,{rows:markets}]=await Promise.all([platformRevenueSummary(pool),liquidityReserveSummary(pool),reconcileLiquidity(pool),reconcilePlatformRevenue(pool),pool.query(publicMarketSQL)])
  return {revenue,reserve,liquidity,revenueCheck,markets}
}
// now, holdMs: the clock and the hold of the ledger alerts (src/ledger-alerts.mjs).
// reconciler, readState, readLedgers: a market's fee reconciliation, its chain state and the pass's own reads; tests replace them.
export function createGraduationMonitor({pool,connection,verification,config,env=process.env,pauseMs=GRADUATION_MARKET_PAUSE_MS,now=Date.now,holdMs=RECONCILE_HOLD_MS,
  reconciler=createReconciler({pool,connection,config}),readState=readGraduationState,readLedgers=readPassLedgers}) {
  // Alert rows that could not be stored or marked in the pass in progress. Never a reason to fail the pass: reported with it.
  let alertFaults=0,lastStarted=null
  const ledgerAlerts=createLedgerAlerts({now,holdMs,onFault:()=>{alertFaults+=1}})
  async function processMarket(market,global,curveReads=null) {
    const db=await pool.connect(),repoId=String(market.githubRepoId),alerts=[]
    const notify=async(kind,key,detail)=>{const a=await emitAlert(db,repoId,kind,key,detail);if(a)alerts.push(a);return a}
    // What this pass finds about the market, for the operator alerts: its fee ledger, settled as soon as the ledger is read so
    // no later step can skip it, and the pass as a whole, verified or failed. Each is recorded once it has lasted its hold.
    const watched=ledgerAlerts.market({record:(key,detail)=>notify(LEDGER_ALERT,key,detail),clear:(ledger,at)=>clearLedgerAlerts(db,repoId,ledger,at)},market)
    let locked=false
    try {
      // BUSY: another pass holds this market and settles it in its own process, so nothing is settled here. Counting it as
      // unchecked would record every market two workers keep taking turns on.
      locked=(await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[`graduation:${repoId}`])).rows[0].locked
      if(!locked)return {repoId,status:'BUSY',alerts}
      try {
        const {rows:[previous]}=await db.query('select * from graduation_observations where github_repo_id=$1',[repoId])
        const state=await readState({connection,verification,config,market,env,db:pool,curveReads})
        const {rows:[existing]}=await db.query('select signature from graduation_events where github_repo_id=$1',[repoId])
        if(existing&&!state.migration)throw Error('GRADUATION_STATE_DISAGREEMENT')
        const reconciliation=await reconciler.reconcile(repoId)
        await watched.settle(reconciliation,state.checkedAt)
        // Persist migration proof even when fee indexing/reconciliation still needs attention.
        await recordGraduationEvidence(db,state,previous,reconciliation)
        if(state.migration){
          // Skipped, not failed, while the worker's 10 s read walks the same pool (src/live-trades.mjs).
          await indexDammTradesLocked({db,connection,verification,market,graduation:state.migration})
          await notify('GRADUATED',state.migration.signature,{signature:state.migration.signature,pool:state.migration.pool,slot:state.migration.slot})
        }
        const {rows:[volumes]}=await db.query(`select
          coalesce((select sum((case when direction='buy' then input_base_units else output_base_units end)::numeric) from trade_events where pool=$1),0)::text as lifetime,
          coalesce((select sum(quote_amount) from damm_trade_events where github_repo_id=$2 and traded_at>=now()-interval '24 hours'),0)::text as damm24h`,[market.pool,repoId])
        state.dammVolume24hLamports=state.migration?volumes.damm24h:null
        let walletBalance=null
        if(state.partnerWallet)walletBalance=String(agreeGraduation(...await Promise.all([connection,verification].map(c=>c.getBalance(new PublicKey(state.partnerWallet),'finalized')))))
        const {rows:[pending]}=await db.query("select count(*)::int as count from platform_fee_claims where github_repo_id=$1 and status='pending'",[repoId])
        state.p3=firstP3Eligibility({state,reconciliation:reconciliation.status,...global,volume:volumes.lifetime,walletBalance,pendingClaims:pending.count})
        if(state.p3.eligible){
          try{await assertPlatformReserveCustody(db,new PublicKey(state.partnerWallet))}
          catch{state.p3={eligible:false,reason:'Revenue is held in the receiving treasury; review spending authority first'}}
        }
        if(state.p3.eligible){
          try {
            const snapshot=await createGraduatedFees({connection,config,db:pool}).read(market)
            await reinvestQuote(connection,{amm:snapshot.amm,state:snapshot.poolState,pool:snapshot.pool},state.p3.maximumInvestment)
          }catch{state.p3={eligible:false,reason:'Bounded liquidity quote unavailable; wait for a fresh review'}}
        }
        state.platformClaimAvailable=Boolean(state.platform&&BigInt(state.platform.available)>0n&&reconciliation.status==='MATCH'&&pending.count===0)
        state.protocolLiquidityAdded=null
        if(state.phase==='GRADUATED'&&reconciliation.status==='MATCH'&&global.liquidity.status==='MATCH'){
          const {rows:positions}=await db.query("select * from liquidity_intents where github_repo_id=$1 and status='settled' and network='mainnet'",[repoId])
          let added=0n
          for(const position of positions){
            const proofs=await Promise.all([connection,verification].map(c=>verifyLiquidityReceipt(c,position)))
            const proof=agreeGraduation(...proofs)
            if(proof?.status!=='settled'||proof.economicDebit!==String(position.settled_debit))throw Error('LP_SETTLEMENT_MISMATCH')
            added+=BigInt(proof.economicDebit)
          }
          if(added>0n)state.protocolLiquidityAdded=String(added)
        }
        for(const n of [75,90])if(state.phase==='GRADUATED'||BigInt(state.reserveLamports)*100n>=BigInt(state.thresholdLamports)*BigInt(n))await notify(`PROGRESS_${n}`,'first',{percent:state.progressPercent,slot:state.slots[0]})
        if(state.platform&&BigInt(state.platform.earned)>0n)await notify('PARTNER_FEES_FIRST_ACCRUED','first',{earned:state.platform.earned,pool:state.destination.pool})
        if(state.platformClaimAvailable)await notify('PLATFORM_CLAIM_AVAILABLE',state.platform.claimed,{available:state.platform.available})
        if(state.p3.eligible)await notify('P3_FIRST_ELIGIBLE','first',{maximumInvestment:state.p3.maximumInvestment,execution:'manual only'})
        assertFreshGraduation(state)
        const reserveAlert=await persistGraduationObservation(db,{market,state,previous,reconciliation,enabled:env.RESERVE_ALERTS_ENABLED==='true',
          notify:env.RESERVE_MOVE_NOTIFICATIONS==='true'})
        if(reserveAlert)alerts.push(reserveAlert)
        await watched.verified()
        return {repoId,status:'VERIFIED',phase:state.phase,reconciliation:reconciliation.status,alerts}
      }catch(error){
        const code=graduationError(error)
        await recordGraduationReview(db,repoId,code)
        await notify('GRADUATION_REVIEW',code,{code})
        await watched.failed(code,TRANSIENT_REVIEW_CODES.includes(code))
        return {repoId,status:'REVIEW',code,alerts}
      }
    }finally{await releaseAfterUnlock(db,()=>locked?db.query('select pg_advisory_unlock(hashtextextended($1,0))',[`graduation:${repoId}`]):null)}
  }
  async function runOnce(){
    const started=now(),sincePrevious=lastStarted===null?0:started-lastStarted
    lastStarted=started
    alertFaults=0
    ledgerAlerts.beginPass()
    const protocol={record:(key,detail)=>emitAlert(pool,null,LEDGER_ALERT,key,detail),clear:(ledger,at)=>clearLedgerAlerts(pool,null,ledger,at)}
    // A pass that cannot go on reports its own failure, with how many alert rows it could not store on the way.
    const stopped=error=>{if(alertFaults&&error instanceof Error)error.alertsNotRecorded=alertFaults;return error}
    // A pass that ends says the same in its results.
    const reported=results=>alertFaults?[...results,{repoId:null,status:'ALERTS_NOT_RECORDED',count:alertFaults,alerts:[]}]:results
    // One provider outage should not block the other worker recovery jobs once per market.
    try {
      if(!verification)throw Error('VERIFICATION_RPC_REQUIRED')
      agreeGraduation(...await Promise.all([connection,verification].map(c=>readGenesisHash(c))))
      await Promise.all([connection,verification].map(c=>c.getSlot('finalized')))
    }catch(error){
      const code=graduationError(error)
      await pool.query("update graduation_observations set status='REVIEW',error_code=$1 where status<>'REVIEW'",[code])
      // While the chain cannot be verified no market is checked: that is recorded by itself once it has lasted its hold.
      const alerts=[await emitAlert(pool,null,'GRADUATION_REVIEW',code,{code}),await ledgerAlerts.checks(protocol,code)].filter(Boolean)
      return reported([{repoId:null,status:'REVIEW',code,alerts}])
    }
    let ledgers
    // The pass ends here, as it always has, and again no market was checked.
    try{ledgers=await readLedgers(pool)}catch(error){await ledgerAlerts.checks(protocol,LEDGER_READS_FAILED);throw stopped(error)}
    const {revenue,reserve,liquidity,revenueCheck,markets}=ledgers
    let rules=null
    // Parsing disabled-gate settings for a read-only readiness check never changes the execution environment.
    try{rules=liquidityConfig({...env,REPO_LIQUIDITY_EXECUTION_ENABLED:'true'})}catch{}
    const global={revenue:{...revenue,reconciliation:revenueCheck},reserve,liquidity,rules},results=[]
    // Curve markets share batched pool/config reads; each market is still agreed and freshness-checked on its own.
    const curveReads=createCurveReads({connection,verification,config,markets})
    try {
      for(const market of markets){
        results.push(await processMarket(market,global,curveReads))
        if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(connection.rpcEndpoint))await new Promise(resolve=>setTimeout(resolve,pauseMs))
      }
    // A pass that dies between two markets leaves every market after that one unchecked.
    }catch(error){await ledgerAlerts.checks(protocol,MARKET_PASS_FAILED);throw stopped(error)}
    // After the markets, so recording never holds a market's pass up. A market's public progress lasts
    // PUBLIC_GRADUATION_MAX_AGE_MS from its last verified pass: a pass that takes longer than that, or starts later than that
    // after the one before, lets it expire. Then the platform's own revenue and liquidity ledgers.
    const slow=Math.max(now()-started,sincePrevious)>PUBLIC_GRADUATION_MAX_AGE_MS
    const recorded=[await ledgerAlerts.checks(protocol,slow?PASS_TOO_SLOW:null),await ledgerAlerts.platform(protocol,{revenue:revenueCheck,liquidity})].filter(Boolean)
    if(recorded.length)results.push({repoId:null,status:'REVIEW',alerts:recorded})
    return reported(results)
  }
  return {runOnce,processMarket}
}

// Review codes for a check that failed to read, not for anything it found: an RPC outage or transport failure, a rate limit,
// two providers not agreeing yet, or a read that came back stale. EVIDENCE_UNAVAILABLE (an unrecognized error) is not one.
export const TRANSIENT_REVIEW_CODES=Object.freeze(['RPC_UNAVAILABLE','RPC_RATE_LIMITED','RPC_DISAGREEMENT','STALE_PROGRESS'])

// A failed pass's review. A transient code never replaces a finding already on record (REVIEW with any other code), so a
// failed read just after a real problem cannot let the curve endpoint serve the observation that problem withdrew; the next
// verified pass replaces both.
export async function recordGraduationReview(db,repoId,code) {
  await db.query(`insert into graduation_observations(github_repo_id,checked_at,status,error_code) values($1,now(),'REVIEW',$2)
    on conflict(github_repo_id) do update set checked_at=excluded.checked_at,status='REVIEW',
      error_code=case when graduation_observations.status='REVIEW' and excluded.error_code=any($3::text[])
        and not (coalesce(graduation_observations.error_code,'')=any($3::text[])) then graduation_observations.error_code
        else excluded.error_code end`,[repoId,code,[...TRANSIENT_REVIEW_CODES]])
}
// transientReview: after one of those, serve the previous verified observation for the rest of its own freshness window
// (PUBLIC_GRADUATION_MAX_AGE_MS), so one failed pass never takes a market page's progress and trade card offline. Only the
// public curve endpoint asks for it; announcements, the graduation race, market lists, share cards and discoverer growth still
// require a verified latest pass, and operator pages read the row's status directly.
export function publicGraduation(row,now=Date.now(),{transientReview=false}={}) {
  const usable=row?.status==='VERIFIED'||(transientReview&&row?.status==='REVIEW'&&TRANSIENT_REVIEW_CODES.includes(row.error_code))
  if(!row||!usable||!row.observation)throw Error(row?.error_code??'PROGRESS_NOT_INDEXED')
  // Fee reconciliation trails the chain during active trading; it gates payouts and operator actions (and raises
  // RECONCILIATION_MISMATCH alerts), not public progress. Migration itself must still be durably proven below.
  const state=assertFreshGraduation(JSON.parse(row.observation),now,PUBLIC_GRADUATION_MAX_AGE_MS)
  assertDurableGraduation(row,state)
  const {phase,status,reserveLamports,thresholdLamports,remainingLamports,progressPercent,checkedAt,chainTime,destination,dammSolLamports,dammVolume24hLamports,protocolLiquidityAdded}=state
  return {phase,status,reserveLamports,thresholdLamports,remainingLamports,progressPercent,checkedAt,chainTime,destination,
    ...(phase==='GRADUATED'?{dammSolLamports,dammVolume24hLamports,protocolLiquidityAdded}:{}),validUntil:new Date(Math.min(Date.parse(checkedAt),Date.parse(chainTime))+PUBLIC_GRADUATION_MAX_AGE_MS).toISOString()}
}
function assertDurableGraduation(row,state){
  if(state.phase!=='GRADUATED')return
  if(!state.migration||!state.migrationHash||row.migration_evidence_hash!==state.migrationHash||
    evidenceHash(state.migration)!==state.migrationHash||state.destination?.pool!==state.migration.pool||
    state.curve!==state.migration.curve||state.config!==state.migration.config||state.mint!==state.migration.mint)
    throw Error('MIGRATION_EVIDENCE_INCOMPLETE')
}
export async function graduationOperatorView(pool,env=process.env) {
  const [{rows},revenue,reserve,liquidity,revenueCheck,{rows:alerts}]=await Promise.all([
    pool.query(`select m.github_repo_id::text as "githubRepoId",m.mint,r.full_name as "fullName",
      o.status,o.observation,o.reconciliation,o.error_code,o.checked_at,e.evidence_hash as migration_evidence_hash from markets m
      join repositories r on r.github_repo_id=m.github_repo_id left join graduation_observations o on o.github_repo_id=m.github_repo_id
      left join graduation_events e on e.github_repo_id=m.github_repo_id
      where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.quote_asset_id is null`),
    platformRevenueSummary(pool),liquidityReserveSummary(pool),reconcileLiquidity(pool),reconcilePlatformRevenue(pool),
    pool.query(`select a.id,a.kind,a.github_repo_id::text as "repoId",r.full_name as "fullName",a.detail,a.created_at as "createdAt",a.acknowledged_at as "acknowledgedAt"
      from graduation_alerts a left join repositories r on r.github_repo_id=a.github_repo_id order by a.id desc limit 100`)
  ])
  const markets=rows.map(row=>{
    const base={repoId:row.githubRepoId,mint:row.mint,fullName:row.fullName,checkedAt:row.checked_at,reconciliation:row.reconciliation?JSON.parse(row.reconciliation).status:'UNAVAILABLE'}
    try{
      if(row.status!=='VERIFIED')throw Error(row.error_code??'PROGRESS_NOT_INDEXED')
      const state=assertFreshGraduation(JSON.parse(row.observation))
      assertDurableGraduation(row,state)
      if(revenueCheck.status!=='MATCH'||liquidity.status!=='MATCH'||reserve.open>0||BigInt(reserve.settled)>0n)
        state.p3={eligible:false,reason:'Refresh the ledger and resolve existing liquidity intents before review'}
      return {...base,status:'VERIFIED',phase:state.phase,progressPercent:state.progressPercent,reserveLamports:state.reserveLamports,thresholdLamports:state.thresholdLamports,
        remainingLamports:state.remainingLamports,pool:state.destination?.pool,platform:state.platform,claimAvailable:state.platformClaimAvailable,p3:state.p3,migration:state.migration}
    }catch(error){return {...base,status:'REVIEW',code:graduationError(error),p3:{eligible:false,reason:'Fresh verified evidence required'}}}
  }).sort((a,b)=>{
    if(a.phase!==b.phase)return (a.phase==='CURVE'?0:a.phase==='GRADUATED'?1:2)-(b.phase==='CURVE'?0:b.phase==='GRADUATED'?1:2)
    if(a.phase!=='CURVE')return 0
    const difference=BigInt(b.reserveLamports)*BigInt(a.thresholdLamports)-BigInt(a.reserveLamports)*BigInt(b.thresholdLamports)
    return difference>0n?1:difference<0n?-1:0
  })
  return {checkedAt:new Date().toISOString(),markets,alerts:alerts.map(a=>({...a,detail:JSON.parse(a.detail)})),revenue,reserve,
    reconciliation:{revenue:revenueCheck.status,liquidity:liquidity.status},execution:{p3:env.REPO_LIQUIDITY_EXECUTION_ENABLED==='true',p4:env.BUILDER_REINVEST_ENABLED==='true'}}
}
