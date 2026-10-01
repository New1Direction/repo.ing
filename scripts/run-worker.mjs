import {createOperatingWalletMonitor} from '../src/operating-wallet-alerts.mjs'
import {createBuilderReminders,createReminderSender,remindersConfigured} from '../src/builder-reminders.mjs'
import {createReconciler} from '../src/reconcile.mjs'
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
import { expireLaunchSessions } from '../src/launch-sessions.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createClaimRecovery } from '../src/claim-settlement.mjs'
import { createTipExpiry, readTipWallet } from '../src/tips.mjs'
import { createTipTransferRecovery, createTipWalletMonitor } from '../src/tip-transfers.mjs'
import { createPartsFundJobs } from '../src/parts-settlement.mjs'
import { createDiscoveryClaims } from '../src/discovery-claims.mjs'
import { createBuybackReceiptsJob } from '../src/buyback-receipts-job.mjs'
import { createLaunchAlerts, createLaunchAlertSenders, createLaunchAlertStore, LaunchAlertConfigError, launchAlertsConfig } from '../src/launch-alerts.mjs'
import { createMilestoneAlerts, createMilestoneAlertStore, milestoneAlertsConfig } from '../src/milestone-alerts.mjs'
import { CANARY_INTERVAL_MS, createTradeCanary } from '../src/trade-canary.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createDammTrader, createTradeRouter } from '../src/canonical-damm-trade.mjs'
import { createRpcMeter, registerRpcEndpoint } from '../src/rpc-usage.mjs'
import { createActivitySchedule, createConfigActivityFeed } from '../src/indexer-schedule.mjs'
import { approvedConfigs } from '../src/market-config.mjs'
import { loadFinalizedTransaction } from '../src/finalized-transaction.mjs'

const { DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc, DBC_CONFIG: config } = process.env
if (!databaseUrl || !rpc || !config) throw new Error('DATABASE_URL, SOLANA_RPC_URL, and DBC_CONFIG are required')
const once = process.argv.includes('--once')
const pool = new pg.Pool({ connectionString: databaseUrl })
// Every Solana RPC request goes through one meter per provider: a compact {"rpcUsage":…} line per minute, and a
// provider answering HTTP 429 (rate limit or exhausted credits) is backed off exponentially instead of hammered.
const meter = createRpcMeter()
const providerFetches = new Map()
const providerFetch = (url, provider) => {
  if (!providerFetches.has(url)) { providerFetches.set(url, meter.fetchFor(provider)); registerRpcEndpoint(url, providerFetches.get(url)) }
  return providerFetches.get(url)
}
providerFetch(rpc, 'primary')
if (process.env.GRADUATION_VERIFICATION_RPC_URL) providerFetch(process.env.GRADUATION_VERIFICATION_RPC_URL, 'verification')
const rpcConnection = (url, commitment, provider = 'primary') => new Connection(url, { commitment, disableRetryOnRateLimit: true, fetch: providerFetch(url, provider) })
const connection = rpcConnection(rpc, 'finalized')
const verify = createLaunchEvidenceVerifier({ connection, config })
// A launch still settling is verified every cycle; an indexed finalized launch is re-checked hourly.
const launches = createLaunchIndexer({ pool, verify, reverifyAfterMs: 3_600_000 })
// Idle markets are checked less often; new config-account signatures and repo.ing trades wake them early.
const fees = createExternalFeeIndexer({ pool, connection, config, schedule: createActivitySchedule(),
  feed: createConfigActivityFeed({ connection, configs: approvedConfigs(config), loadTransaction: loadFinalizedTransaction }) })
// Recovery only needs already authorized, signed intents. No partner key here.
const liquidity = createLiquidityRecovery({ pool, connection })
// Only recover already issued/approved intents. Never prepare or sign a builder action.
const reinvest = process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL ? createBuilderReinvestRecovery({pool,connection,
  verification:rpcConnection(process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL,'finalized','reinvestVerification')}) : null
const claims = createClaimRecovery({ pool, connection })
const platformFees = createPlatformFeeRecovery({ pool, connection })
// Tips: settle/abort already-signed tip-wallet transfers and resolve abandoned tips. Never signs; no key needed.
const tipTransfers = createTipTransferRecovery({ pool, connection })
const tipExpiry = createTipExpiry({ pool, connection })
const tipWalletAddress = () => { try { return process.env.TIP_WALLET_ADDRESS?.trim() || readTipWallet()?.publicKey.toBase58() || null } catch { return null } }
const tipMonitor = createTipWalletMonitor({ pool, connection, wallets: () => [tipWalletAddress()].filter(Boolean) })
let tipMonitorTask=null,nextTipMonitorCheck=0
async function observeTipWallet(){
  try{console.log(JSON.stringify({tipWallet:await tipMonitor.runOnce()}))}
  catch(error){console.log(JSON.stringify({tipWalletError:error?.code==='42P01'?'TIPS_NOT_MIGRATED':'TIP_WALLET_UNVERIFIED'}))}
}
// Parts funds: expire abandoned pledges, decide lists past their deadline and mark finished lists settled (keyless).
// All-or-nothing payouts/refunds are signed here only when this worker also has TIP_WALLET_SECRET_KEY; without it,
// maintainers' "Send now" on the token page sends them and /operations/health flags lists left waiting.
const partsSigner = (() => { try { return readTipWallet() } catch { return null } })()
const partsFunds = createPartsFundJobs({ pool, connection, signer: partsSigner })
let partsTask=null,nextPartsCheck=0
async function observePartsFunds(){
  try{
    const r=await partsFunds.runOnce()
    console.log(JSON.stringify({partsFunds:{signer:Boolean(partsSigner),pledges:r.pledges,decided:r.decided,settled:r.settled,
      transfers:r.transfers?.map(t=>({fundId:t.fundId,kind:t.kind,mint:t.mint,status:t.status,signature:t.signature}))}}))
    if(r.pledges.some(p=>p.state==='review')||r.decided.some(d=>d.status==='review')||r.transfers?.some(t=>t.status==='failed'))process.exitCode=1
  }catch(error){console.log(JSON.stringify({partsFundError:error?.code==='42P01'?'PARTS_NOT_MIGRATED':'PARTS_FUND_UNAVAILABLE'}))}
}
const allocations = createAllocationRecovery({ pool, connection })
const discovery = createDiscoveryClaims({ pool, connection, config })
// The 15 s timeout starts after any backoff wait, so a short rate-limit pause never eats the request's own budget.
const timedFetch=(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})
const graduationFetches={primary:meter.fetchFor('primary',timedFetch),verification:meter.fetchFor('verification',timedFetch)}
const graduationRPC=url=>new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,
  fetch:async(url,options)=>{
    const response=await graduationFetches[url===rpc?'primary':'verification'](url,options)
    if(!response.ok){await response.body?.cancel();throw Error(response.status===429?'RPC_RATE_LIMITED':'RPC_UNAVAILABLE')}
    return response
  }})
const graduation=createGraduationMonitor({pool,connection:graduationRPC(rpc),config,verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
const operatingWallets=createOperatingWalletMonitor({pool,connections:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?[graduationRPC(rpc),graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL)]:[]})
let operatingWalletTask=null,nextOperatingWalletCheck=0
async function observeOperatingWallets(){
  try{console.log(JSON.stringify({operatingWallets:await operatingWallets.runOnce()}))}
  catch{console.log(JSON.stringify({operatingWalletError:'OPERATING_BALANCE_UNVERIFIED'}))}
}
let nextGraduationCheck=0,graduationTask=null
const chartOrdering=createChartOrdering({pool,connection:graduationRPC(rpc),verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
let chartOrderingTask=null,nextChartOrderingCheck=0
async function observeChartOrdering(){
  try{console.log(JSON.stringify({chartOrdering:await chartOrdering.runOnce()}))}
  catch{console.log(JSON.stringify({chartOrderingError:'Chart ordering verification unavailable'}))}
}
let reminderTask=null,nextReminderCheck=0
const reminders=remindersConfigured()?createBuilderReminders({pool,send:createReminderSender(),secret:process.env.BUILDER_REMINDER_SECRET,
  origin:new URL(process.env.APP_ORIGIN).origin,reconcile:createReconciler({pool,connection:graduationRPC(rpc),config}).reconcile}):null
async function deliverBuilderReminders(){
  try{console.log(JSON.stringify({builderReminders:await reminders.runOnce()}))}
  catch{console.log(JSON.stringify({builderReminderError:'REMINDERS_UNAVAILABLE'}))}
}
// Read-only disclosure: detects finalized $REPOING buybacks by the custody and team wallets.
const buybackReceipts=createBuybackReceiptsJob({pool,connection:graduationRPC(rpc)})
let buybackReceiptTask=null,nextBuybackReceiptCheck=0
async function observeBuybackReceipts(){
  try{console.log(JSON.stringify({buybackReceipts:await buybackReceipts.runOnce()}))}
  catch{console.log(JSON.stringify({buybackReceiptError:'BUYBACK_RECEIPTS_UNAVAILABLE'}))}
}
// Public "new market launched" posts to Telegram/X. Off unless LAUNCH_ALERTS_ENABLED=true, LAUNCH_ALERTS_SINCE and a
// channel's credentials are set; silent when off. Posts are claimed in launch_alerts before sending (never twice).
let launchAlerts=null,launchAlertTask=null,nextLaunchAlertCheck=0
try{
  const launchAlertConfig=launchAlertsConfig()
  if(launchAlertConfig)launchAlerts=createLaunchAlerts({store:createLaunchAlertStore(pool),config:launchAlertConfig,senders:createLaunchAlertSenders(launchAlertConfig)})
}catch(error){console.log(JSON.stringify({launchAlertError:error instanceof LaunchAlertConfigError?error.message:'LAUNCH_ALERTS_CONFIG_INVALID'}))}
async function deliverLaunchAlerts(){
  try{
    const r=await launchAlerts.runOnce()
    if(r.posts?.length||r.interrupted?.length||r.skipped==='LAUNCH_ALERTS_NOT_MIGRATED')console.log(JSON.stringify({launchAlerts:r}))
  }catch{console.log(JSON.stringify({launchAlertError:'LAUNCH_ALERTS_UNAVAILABLE'}))}
}
// Public graduation-milestone posts (25/50/75/90% and graduation) to the same channels. Off unless
// GRADUATION_ALERTS_ENABLED=true and GRADUATION_ALERTS_SINCE are set; claimed in milestone_alerts before sending.
let milestoneAlerts=null,milestoneAlertTask=null,nextMilestoneAlertCheck=0
try{
  const milestoneAlertConfig=milestoneAlertsConfig()
  if(milestoneAlertConfig)milestoneAlerts=createMilestoneAlerts({store:createMilestoneAlertStore(pool),config:milestoneAlertConfig,senders:createLaunchAlertSenders(milestoneAlertConfig)})
}catch(error){console.log(JSON.stringify({milestoneAlertError:error instanceof LaunchAlertConfigError?error.message:'GRADUATION_ALERTS_CONFIG_INVALID'}))}
async function deliverMilestoneAlerts(){
  try{
    const r=await milestoneAlerts.runOnce()
    if(r.posts?.length||r.interrupted?.length||r.skipped==='MILESTONE_ALERTS_NOT_MIGRATED')console.log(JSON.stringify({milestoneAlerts:r}))
  }catch{console.log(JSON.stringify({milestoneAlertError:'GRADUATION_ALERTS_UNAVAILABLE'}))}
}
// Operator-only trade canary: real prepare path, simulation only. Never signs or sends; the payer is unsigned.
const canaryConnection=rpcConnection(rpc,'confirmed')
const tradeCanary=process.env.TRADE_CANARY_ENABLED==='false'?null:createTradeCanary({db:pool,connection:canaryConnection,
  router:createTradeRouter({curve:createCanonicalTrader({pool,connection:canaryConnection,config}),graduated:createDammTrader({pool,connection:canaryConnection,config})})})
let tradeCanaryTask=null,nextTradeCanaryCheck=0
async function observeTradeCanary(){
  try{console.log(JSON.stringify({tradeCanary:await tradeCanary.runOnce()}))}
  catch(error){console.log(JSON.stringify({tradeCanaryError:error?.code==='42P01'?'TRADE_CANARY_NOT_MIGRATED':'TRADE_CANARY_UNAVAILABLE'}))}
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
// Attribute every job's RPC calls in the usage line (byJob); calls outside a job count as "other".
for(const [job,worker] of Object.entries({launches,fees,claims,allocations,discovery,liquidity,reinvest,platformFees,tipTransfers,tipExpiry,
  tipMonitor,partsFunds,chartOrdering,graduation,operatingWallets,buybackReceipts,tradeCanary,reminders})){
  if(!worker)continue
  const run=worker.runOnce;worker.runOnce=(...args)=>meter.track(job,()=>run.apply(worker,args))
}
const stopUsageReport=once?null:meter.report(60_000)
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
    // Expired launch reviews release their 'prepared' market even when no web request arrives to sweep them.
    try { const swept = await expireLaunchSessions(pool); if (swept.removed) result.launchSessions = swept }
    catch (error) { if (error?.code !== '42P01') result.launchSessionError = 'Launch session expiry unavailable' }
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
    try { result.tipTransfers = await tipTransfers.runOnce(); result.tips = await tipExpiry.runOnce() }
    catch (error) { result.tipError = error?.code === '42P01' ? null : 'Tip recovery unavailable' }
    // Paced like the other observers so a batch of refunds never delays indexing or tip recovery.
    if(once)await observePartsFunds()
    else if(!partsTask&&Date.now()>=nextPartsCheck)
      partsTask=observePartsFunds().finally(()=>{nextPartsCheck=Date.now()+30000;partsTask=null})
    if(once)await observeTipWallet()
    else if(!tipMonitorTask&&Date.now()>=nextTipMonitorCheck)
      tipMonitorTask=observeTipWallet().finally(()=>{nextTipMonitorCheck=Date.now()+300000;tipMonitorTask=null})
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
      else if(!trendTask&&Date.now()>=nextTrendCheck)trendTask=observeTrends().finally(()=>{nextTrendCheck=Date.now()+300000;trendTask=null})
    }
    if(once)await observeBuybackReceipts()
    else if(!buybackReceiptTask&&Date.now()>=nextBuybackReceiptCheck)
      buybackReceiptTask=observeBuybackReceipts().finally(()=>{nextBuybackReceiptCheck=Date.now()+180000;buybackReceiptTask=null})
    if(tradeCanary){
      if(once)await observeTradeCanary()
      else if(!tradeCanaryTask&&Date.now()>=nextTradeCanaryCheck)
        tradeCanaryTask=observeTradeCanary().finally(()=>{nextTradeCanaryCheck=Date.now()+CANARY_INTERVAL_MS;tradeCanaryTask=null})
    }
    if(once)await observeOperatingWallets()
    else if(!operatingWalletTask&&Date.now()>=nextOperatingWalletCheck)
      operatingWalletTask=observeOperatingWallets().finally(()=>{nextOperatingWalletCheck=Date.now()+900000;operatingWalletTask=null})
    // Notification network failures never block fee indexing or authorized recovery.
    if(reserveDelivery){
      if(once)await deliverReserveAlerts()
      else if(!reserveDeliveryTask&&Date.now()>=nextReserveDeliveryCheck)
        reserveDeliveryTask=deliverReserveAlerts().finally(()=>{nextReserveDeliveryCheck=Date.now()+120000;reserveDeliveryTask=null})
    }
    if(launchAlerts){
      if(once)await deliverLaunchAlerts()
      else if(!launchAlertTask&&Date.now()>=nextLaunchAlertCheck)
        launchAlertTask=deliverLaunchAlerts().finally(()=>{nextLaunchAlertCheck=Date.now()+60000;launchAlertTask=null})
    }
    if(milestoneAlerts){
      if(once)await deliverMilestoneAlerts()
      else if(!milestoneAlertTask&&Date.now()>=nextMilestoneAlertCheck)
        milestoneAlertTask=deliverMilestoneAlerts().finally(()=>{nextMilestoneAlertCheck=Date.now()+60000;milestoneAlertTask=null})
    }
    if(reminders){
      if(once)await deliverBuilderReminders()
      else if(!reminderTask&&Date.now()>=nextReminderCheck)
        reminderTask=deliverBuilderReminders().finally(()=>{nextReminderCheck=Date.now()+300000;reminderTask=null})
    }
    console.log(JSON.stringify(result, (key, value) => {
      if (typeof value === 'bigint') return value.toString()
      if (['error', 'reason', 'launchError', 'feeError'].includes(key) && typeof value === 'string') return 'Indexer error'
      return value
    }))
    if (result.tipError || result.tipTransfers?.some(item => item.status === 'review') || result.tips?.some(item => item.state === 'review') || result.reinvestError || result.reinvest?.some(item => item.status === 'review') || result.liquidityError || result.liquidity?.some(item => item.status === 'review') || result.platformFeeError || result.platformFees?.some(item => item.status === 'review' || item.status === 'error') || result.allocationError || result.allocations?.some(item => item.status === 'review') || result.launchError || result.feeError || result.claimError || result.claims?.some(item => item.status === 'review') || result.discoveryError || result.discovery?.some(item => item.status === 'review') ||
        result.launches?.some(item => ['invalid', 'mismatch', 'missing', 'unavailable'].includes(item.state)) ||
        result.fees?.some(item => item.status === 'ERROR')) process.exitCode = 1
    if (!once) await delay(5000)
  } while (!once)
} finally { if(launchAlertTask)await launchAlertTask;if(milestoneAlertTask)await milestoneAlertTask;if(partsTask)await partsTask;if(tipMonitorTask)await tipMonitorTask;if(tradeCanaryTask)await tradeCanaryTask;if(buybackReceiptTask)await buybackReceiptTask;if(operatingWalletTask)await operatingWalletTask;if(reminderTask)await reminderTask;if(graduationTask)await graduationTask;if(chartOrderingTask)await chartOrderingTask;if(trendTask)await trendTask;if(reserveDeliveryTask)await reserveDeliveryTask;await pool.end()
  stopUsageReport?.();const usage=meter.flush();if(usage)console.log(JSON.stringify(usage)) }
