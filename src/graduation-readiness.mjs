import { PublicKey } from '@solana/web3.js'
import { createReconciler } from './reconcile.mjs'
import { platformRevenueSummary, reconcilePlatformRevenue, assertPlatformReserveCustody } from './platform-revenue.mjs'
import { liquidityConfig, liquidityReserveSummary, reconcileLiquidity } from './liquidity-deployment.mjs'
import { createGraduatedFees } from './graduated-fees.mjs'
import { reinvestQuote } from './builder-reinvest-chain.mjs'
import { verifyLiquidityReceipt } from './liquidity-settlement.mjs'
import { indexDammTrades } from './damm-trades.mjs'
import { readGraduationState, assertFreshGraduation, agreeGraduation, evidenceJSON, evidenceHash } from './graduation-state.mjs'
import { persistGraduationObservation } from './reserve-alerts.mjs'

export const graduationError = error => /^[A-Z][A-Z_]{3,60}$/.test(error?.message??'') ? error.message : 'EVIDENCE_UNAVAILABLE'
const publicMarketSQL=`select m.github_repo_id::text as "githubRepoId",m.mint,m.pool,m.creator_wallet as "creatorWallet",r.full_name as "fullName"
  from markets m join repositories r on r.github_repo_id=m.github_repo_id where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'`

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

export function createGraduationMonitor({pool,connection,verification,config,env=process.env}) {
  const reconciler=createReconciler({pool,connection,config})
  async function processMarket(market,global) {
    const db=await pool.connect(),repoId=String(market.githubRepoId),alerts=[]
    const notify=async(kind,key,detail)=>{const a=await emitAlert(db,repoId,kind,key,detail);if(a)alerts.push(a)}
    try {
      if(!(await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[`graduation:${repoId}`])).rows[0].locked)return {repoId,status:'BUSY',alerts}
      try {
        const {rows:[previous]}=await db.query('select * from graduation_observations where github_repo_id=$1',[repoId])
        const state=await readGraduationState({connection,verification,config,market,env,db:pool})
        const {rows:[existing]}=await db.query('select signature from graduation_events where github_repo_id=$1',[repoId])
        if(existing&&!state.migration)throw Error('GRADUATION_STATE_DISAGREEMENT')
        const reconciliation=await reconciler.reconcile(repoId)
        // Persist migration proof even when fee indexing/reconciliation still needs attention.
        await recordGraduationEvidence(db,state,previous,reconciliation)
        if(state.migration){
          await indexDammTrades({db,connection,verification,market,graduation:state.migration})
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
        if(reconciliation.status!=='MATCH')await notify('RECONCILIATION_MISMATCH',evidenceHash(reconciliation),{status:reconciliation.status})
        assertFreshGraduation(state)
        const reserveAlert=await persistGraduationObservation(db,{market,state,previous,reconciliation,enabled:env.RESERVE_ALERTS_ENABLED==='true'})
        if(reserveAlert)alerts.push(reserveAlert)
        return {repoId,status:'VERIFIED',phase:state.phase,reconciliation:reconciliation.status,alerts}
      }catch(error){
        const code=graduationError(error)
        await db.query(`insert into graduation_observations(github_repo_id,checked_at,status,error_code) values($1,now(),'REVIEW',$2)
          on conflict(github_repo_id) do update set checked_at=excluded.checked_at,status='REVIEW',error_code=excluded.error_code`,[repoId,code])
        await notify('GRADUATION_REVIEW',code,{code})
        return {repoId,status:'REVIEW',code,alerts}
      }finally{await db.query('select pg_advisory_unlock(hashtextextended($1,0))',[`graduation:${repoId}`])}
    }finally{db.release()}
  }
  async function runOnce(){
    // One provider outage should not block the other worker recovery jobs once per market.
    try {
      if(!verification)throw Error('VERIFICATION_RPC_REQUIRED')
      agreeGraduation(...await Promise.all([connection,verification].map(c=>c.getGenesisHash())))
      await Promise.all([connection,verification].map(c=>c.getSlot('finalized')))
    }catch(error){
      const code=graduationError(error)
      await pool.query("update graduation_observations set status='REVIEW',error_code=$1 where status<>'REVIEW'",[code])
      const alert=await emitAlert(pool,null,'GRADUATION_REVIEW',code,{code})
      return [{repoId:null,status:'REVIEW',code,alerts:alert?[alert]:[]}]
    }
    const [revenue,reserve,liquidity,revenueCheck,{rows:markets}]=await Promise.all([platformRevenueSummary(pool),liquidityReserveSummary(pool),reconcileLiquidity(pool),reconcilePlatformRevenue(pool),pool.query(publicMarketSQL)])
    let rules=null
    // Parsing disabled-gate settings for a read-only readiness check never changes the execution environment.
    try{rules=liquidityConfig({...env,REPO_LIQUIDITY_EXECUTION_ENABLED:'true'})}catch{}
    const global={revenue:{...revenue,reconciliation:revenueCheck},reserve,liquidity,rules},results=[]
    for(const market of markets){
      results.push(await processMarket(market,global))
      if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(connection.rpcEndpoint))await new Promise(resolve=>setTimeout(resolve,2000))
    }
    if(revenueCheck.status!=='MATCH'||liquidity.status!=='MATCH'){
      const alert=await emitAlert(pool,null,'RECONCILIATION_MISMATCH',evidenceHash([revenueCheck,liquidity]),{revenue:revenueCheck.status,liquidity:liquidity.status})
      if(alert)results.push({repoId:null,status:'REVIEW',alerts:[alert]})
    }
    return results
  }
  return {runOnce,processMarket}
}

export function publicGraduation(row,now=Date.now()) {
  if(!row||row.status!=='VERIFIED'||!row.observation)throw Error(row?.error_code??'PROGRESS_NOT_INDEXED')
  const state=assertFreshGraduation(JSON.parse(row.observation),now),reconciliation=JSON.parse(row.reconciliation)
  if(state.phase==='GRADUATED'&&reconciliation.status!=='MATCH')throw Error('RECONCILIATION_MISMATCH')
  assertDurableGraduation(row,state)
  const {phase,status,reserveLamports,thresholdLamports,remainingLamports,progressPercent,checkedAt,chainTime,destination,dammSolLamports,dammVolume24hLamports,protocolLiquidityAdded}=state
  return {phase,status,reserveLamports,thresholdLamports,remainingLamports,progressPercent,checkedAt,chainTime,destination,
    ...(phase==='GRADUATED'?{dammSolLamports,dammVolume24hLamports,protocolLiquidityAdded}:{}),validUntil:new Date(Math.min(Date.parse(checkedAt),Date.parse(chainTime))+120000).toISOString()}
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
      where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'`),
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
