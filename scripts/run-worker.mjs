import pg from 'pg'
import { createChartOrdering } from '../src/chart-ordering.mjs'
import { createTrendIntake } from '../src/trend-intake.mjs'
import { createLiquidityRecovery } from '../src/liquidity-settlement.mjs'
import { createBuilderReinvestRecovery } from '../src/builder-reinvest.mjs'
import { createGraduationMonitor } from '../src/graduation-readiness.mjs'
import { createReserveAlertDelivery, createReserveWebhookSender } from '../src/reserve-alerts.mjs'
import { createAllocationRecovery } from '../src/builder-allocation-settlement.mjs'
import { createPlatformFeeRecovery } from '../src/platform-fees.mjs'
import { Connection } from '@solana/web3.js'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createClaimRecovery } from '../src/claim-settlement.mjs'
import { createDiscoveryClaims } from '../src/discovery-claims.mjs'

const { DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc, DBC_CONFIG: config } = process.env
if (!databaseUrl || !rpc || !config) throw new Error('DATABASE_URL, SOLANA_RPC_URL, and DBC_CONFIG are required')
const once = process.argv.includes('--once')
const pool = new pg.Pool({ connectionString: databaseUrl })
const connection = new Connection(rpc, 'finalized')
const verify = createLaunchEvidenceVerifier({ connection, config })
const launches = createLaunchIndexer({ pool, verify })
const fees = createExternalFeeIndexer({ pool, connection, config })
// Recovery only needs already authorized, signed intents. No partner key here.
const liquidity = createLiquidityRecovery({ pool, connection })
// Only recover already issued/approved intents. Never prepare or sign a builder action.
const reinvest = process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL ? createBuilderReinvestRecovery({pool,connection,
  verification:new Connection(process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL,'finalized')}) : null
const claims = createClaimRecovery({ pool, connection })
const platformFees = createPlatformFeeRecovery({ pool, connection })
const allocations = createAllocationRecovery({ pool, connection })
const discovery = createDiscoveryClaims({ pool, connection, config })
const graduationRPC=url=>new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,
  fetch:async(url,options)=>{
    const response=await fetch(url,{...options,signal:AbortSignal.timeout(15000)})
    if(!response.ok){await response.body?.cancel();throw Error(response.status===429?'RPC_RATE_LIMITED':'RPC_UNAVAILABLE')}
    return response
  }})
const graduation=createGraduationMonitor({pool,connection:graduationRPC(rpc),config,verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
let nextGraduationCheck=0,graduationTask=null
const chartOrdering=createChartOrdering({pool,connection:graduationRPC(rpc),verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
let chartOrderingTask=null,nextChartOrderingCheck=0
async function observeChartOrdering(){
  try{console.log(JSON.stringify({chartOrdering:await chartOrdering.runOnce()}))}
  catch{console.log(JSON.stringify({chartOrderingError:'Chart ordering verification unavailable'}))}
}
const trends=createTrendIntake({pool})
let trendTask=null,nextTrendCheck=0
let reserveDelivery=null,reserveDeliveryTask=null,nextReserveDeliveryCheck=0
if(process.env.RESERVE_ALERTS_ENABLED==='true'){
  try{reserveDelivery=createReserveAlertDelivery({pool,send:createReserveWebhookSender()})}
  catch{console.log(JSON.stringify({reserveAlertError:'ALERT_DESTINATION_INVALID'}))}
}
async function deliverReserveAlerts(){
  try{console.log(JSON.stringify({reserveAlerts:await reserveDelivery.runOnce()}))}
  catch{console.log(JSON.stringify({reserveAlertError:'RESERVE_DELIVERY_UNAVAILABLE'}))}
}
async function observeTrends(){
  try{console.log(JSON.stringify({trends:await trends.runOnce()}))}
  catch{console.log(JSON.stringify({trendError:'Trend intake unavailable'}))}
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function observeGraduation(){
  const result={}
  try{result.graduation=await graduation.runOnce()}catch{result.graduationError='Graduation readiness unavailable'}
  if(result.graduationError||result.graduation?.some(item=>item.status==='REVIEW'))process.exitCode=1
  console.log(JSON.stringify(result))
}

try {
  do {
    const result = {}
    try { result.launches = await launches.runOnce() }
    catch (error) { result.launchError = error.message }
    try { result.claims = await claims.runOnce() }
    catch { result.claimError = 'Claim recovery unavailable' }
    try { result.allocations = await allocations.runOnce() }
    catch { result.allocationError = 'Allocation recovery unavailable' }
    try { result.fees = await fees.runOnce() }
    catch (error) { result.feeError = error.message }
    try { result.discovery = await discovery.runOnce() }
    catch { result.discoveryError = 'Discovery recovery unavailable' }
    try { result.liquidity = await liquidity.runOnce() }
    catch { result.liquidityError = 'Liquidity recovery unavailable' }
    try { if (reinvest) result.reinvest = await reinvest.runOnce() }
    catch { result.reinvestError = 'Builder reinvestment recovery unavailable' }
    try { result.platformFees = await platformFees.runOnce() }
    catch { result.platformFeeError = 'Platform fee recovery unavailable' }
    // Keep paced verification from delaying trading indexes and already-approved recovery.
    if(once)await observeChartOrdering()
    else if(!chartOrderingTask&&Date.now()>=nextChartOrderingCheck)
      chartOrderingTask=observeChartOrdering().finally(()=>{nextChartOrderingCheck=Date.now()+30000;chartOrderingTask=null})
    // At most one observation pass runs; it uses its own per-market advisory lock.
    if(once)await observeGraduation()
    else if(!graduationTask&&Date.now()>=nextGraduationCheck)
      graduationTask=observeGraduation().finally(()=>{nextGraduationCheck=Date.now()+30000;graduationTask=null})
    if(process.env.TREND_INTAKE_ENABLED==='true'){
      if(once)await observeTrends()
      else if(!trendTask&&Date.now()>=nextTrendCheck)trendTask=observeTrends().finally(()=>{nextTrendCheck=Date.now()+60000;trendTask=null})
    }
    // Notification network failures never block fee indexing or authorized recovery.
    if(reserveDelivery){
      if(once)await deliverReserveAlerts()
      else if(!reserveDeliveryTask&&Date.now()>=nextReserveDeliveryCheck)
        reserveDeliveryTask=deliverReserveAlerts().finally(()=>{nextReserveDeliveryCheck=Date.now()+30000;reserveDeliveryTask=null})
    }
    console.log(JSON.stringify(result, (key, value) => {
      if (typeof value === 'bigint') return value.toString()
      if (['error', 'reason', 'launchError', 'feeError'].includes(key) && typeof value === 'string') return 'Indexer error'
      return value
    }))
    if (result.reinvestError || result.reinvest?.some(item => item.status === 'review') || result.liquidityError || result.liquidity?.some(item => item.status === 'review') || result.platformFeeError || result.platformFees?.some(item => item.status === 'review' || item.status === 'error') || result.allocationError || result.allocations?.some(item => item.status === 'review') || result.launchError || result.feeError || result.claimError || result.claims?.some(item => item.status === 'review') || result.discoveryError || result.discovery?.some(item => item.status === 'review') ||
        result.launches?.some(item => ['invalid', 'mismatch', 'missing', 'unavailable'].includes(item.state)) ||
        result.fees?.some(item => item.status === 'ERROR')) process.exitCode = 1
    if (!once) await delay(5000)
  } while (!once)
} finally { if(graduationTask)await graduationTask;if(chartOrderingTask)await chartOrderingTask;if(trendTask)await trendTask;if(reserveDeliveryTask)await reserveDeliveryTask;await pool.end() }
