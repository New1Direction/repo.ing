import {createOperatingWalletMonitor} from '../src/operating-wallet-alerts.mjs'
import {createBuilderReminders,createReminderSender,remindersConfigured} from '../src/builder-reminders.mjs'
import {createReconciler} from '../src/reconcile.mjs'
import { createDatabasePool } from '../src/database-pool.mjs'
import { createChartOrdering } from '../src/chart-ordering.mjs'
import { createTrendIntake } from '../src/trend-intake.mjs'
import { createLiquidityRecovery } from '../src/liquidity-settlement.mjs'
import { createBuilderReinvestRecovery } from '../src/builder-reinvest.mjs'
import { createGraduationMonitor } from '../src/graduation-readiness.mjs'
import { createGraduatedTradeIndexer, createLiveTrades, pruneLiveTrades } from '../src/live-trades.mjs'
import { createLineageBackfill } from '../src/repo-lineage.mjs'
import { createStockGraduationMonitor, stockGraduationPass } from '../src/stock-graduation-monitor.mjs'
import { createReserveAlertDelivery, createReserveWebhookSender } from '../src/reserve-alerts.mjs'
import { createAllocationRecovery } from '../src/builder-allocation-settlement.mjs'
import { createPlatformFeeRecovery } from '../src/platform-fees.mjs'
import { Connection } from '@solana/web3.js'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createExpiredLaunchCheck } from '../src/launch-expiry.mjs'
import { expireLaunchSessions } from '../src/launch-sessions.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createClaimRecovery } from '../src/claim-settlement.mjs'
import { activateDuePayoutAddresses } from '../src/payout-address.mjs'
import { createTipExpiry, readTipWallet } from '../src/tips.mjs'
import { createTipTransferRecovery, createTipWalletMonitor } from '../src/tip-transfers.mjs'
import { createPartsFundJobs } from '../src/parts-settlement.mjs'
import { createDiscoveryClaims } from '../src/discovery-claims.mjs'
import { createVerificationBonusAccrual } from '../src/verification-bonus-accrual.mjs'
import { createVerificationBonusPayouts } from '../src/verification-bonus-payouts.mjs'
import { createBuybackReceiptsJob } from '../src/buyback-receipts-job.mjs'
import { createStockExecutionJob, STOCK_EXECUTION_INTERVAL_MS, stockExecutionLoud } from '../src/stock-execution-job.mjs'
import { createLaunchAlerts, createLaunchAlertSenders, createLaunchAlertStore, createModelAlertFacts, LaunchAlertConfigError, launchAlertsConfig } from '../src/launch-alerts.mjs'
import { createMilestoneAlerts, createMilestoneAlertStore, milestoneAlertsConfig } from '../src/milestone-alerts.mjs'
import { CANARY_INTERVAL_MS, createTradeCanary } from '../src/trade-canary.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createDammTrader, createTradeRouter } from '../src/canonical-damm-trade.mjs'
import { createRpcMeter, registerRpcEndpoint } from '../src/rpc-usage.mjs'
import { createFailoverFetch, verificationRpcUrls } from '../src/rpc-failover.mjs'
import { createActivitySchedule, createConfigActivityFeed } from '../src/indexer-schedule.mjs'
import { approvedConfigs } from '../src/market-config.mjs'
import { loadFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { createDevPulseCollector } from '../src/dev-pulse.mjs'
import { createPromotionExclusions } from '../app/lib/promotion-exclusions.mjs'
import { createStockFeeIndexer } from '../src/stock-fee-indexer.mjs'
import { stockQuoteConfigs } from '../src/quote-configs.mjs'
import { createStockReconcileRunner, STOCK_RECONCILE_INTERVAL_MS } from '../src/stock-reconcile.mjs'

const { DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc, DBC_CONFIG: config } = process.env
if (!databaseUrl || !rpc || !config) throw new Error('DATABASE_URL, SOLANA_RPC_URL, and DBC_CONFIG are required')
const once = process.argv.includes('--once')
const pool = createDatabasePool({ connectionString: databaseUrl })
// Never promoted: PROMOTION_EXCLUDED_REPO_IDS plus maintainers' opt-outs (re-read at most every 30 s). Dev Pulse and the
// launch/milestone alerts read it each run; a run that cannot read it does nothing.
const promotionExcluded = createPromotionExclusions({ pool })
// Every Solana RPC request goes through one meter per provider: a compact {"rpcUsage":…} line per minute, and a
// provider answering HTTP 429 (rate limit or exhausted credits) is backed off exponentially instead of hammered.
const meter = createRpcMeter()
const providerFetches = new Map()
const providerFetch = (url, provider) => {
  if (!providerFetches.has(url)) { providerFetches.set(url, meter.fetchFor(provider)); registerRpcEndpoint(url, providerFetches.get(url)) }
  return providerFetches.get(url)
}
providerFetch(rpc, 'primary')
// The verification side asks GRADUATION_VERIFICATION_RPC_URL, then each GRADUATION_VERIFICATION_FALLBACK_RPC_URLS
// provider, per request (src/rpc-failover.mjs), so one free provider refusing a call never stops verification. Each has
// its own meter line and backoff: 'verification', then 'verification2'… Raw transaction reads find it by the first URL.
const verificationUrls = verificationRpcUrls(process.env)
const verificationFetch = fetchImpl => createFailoverFetch(verificationUrls.map((url, index) =>
  ({ url, fetch: meter.fetchFor(index ? `verification${index + 1}` : 'verification', fetchImpl) })))
if (verificationUrls.length) { providerFetches.set(verificationUrls[0], verificationFetch()); registerRpcEndpoint(verificationUrls[0], providerFetches.get(verificationUrls[0])) }
const rpcConnection = (url, commitment, provider = 'primary') => new Connection(url, { commitment, disableRetryOnRateLimit: true, fetch: providerFetch(url, provider) })
const connection = rpcConnection(rpc, 'finalized')
const verify = createLaunchEvidenceVerifier({ connection, config })
// An attempt whose transaction never landed is released for retry once two independent providers prove its blockhash
// expired (src/launch-expiry.mjs): the primary, and the verification side on another host. Each read times out after 15 s
// so a stalled provider never holds up the loop. Without an independent provider, it waits for an operator.
const hostOf = url => { try { return new URL(url).host } catch { return null } }
const proofFetch = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
const proofConnection = (url, fetch) => new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch })
const expiredLaunch = hostOf(verificationUrls[0]) && hostOf(verificationUrls[0]) !== hostOf(rpc)
  ? createExpiredLaunchCheck({ connections: [proofConnection(rpc, meter.fetchFor('primary', proofFetch)),
    proofConnection(verificationUrls[0], verificationFetch(proofFetch))] }) : null
// A launch still settling is verified every cycle; an indexed finalized launch is re-checked hourly.
const launches = createLaunchIndexer({ pool, verify, expiredLaunch, reverifyAfterMs: 3_600_000 })
// Idle markets are checked less often; new config-account signatures and repo.ing trades wake them early.
const fees = createExternalFeeIndexer({ pool, connection, config, schedule: createActivitySchedule(),
  feed: createConfigActivityFeed({ connection, configs: approvedConfigs(config), loadTransaction: loadFinalizedTransaction }) })
// Stock-paired curves (docs/STOCK_QUOTES.md): their own ledgers, cursors and schedule; the feed watches the stock configs. A
// malformed STOCK_QUOTE_CONFIGS fails only stock markets: each one resolves its config itself and reports the ERROR.
const stockFees = createStockFeeIndexer({ pool, connection, config, schedule: createActivitySchedule(),
  feed: createConfigActivityFeed({ connection, configs: (() => { try { return [...stockQuoteConfigs().values()] } catch { return [] } })(),
    loadTransaction: loadFinalizedTransaction }) })
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
// Verification bonus: accrue bonuses from first maintainer verifications (PostgreSQL + public GitHub reads) and settle
// or rebroadcast payouts already signed on web. No key: the worker never signs or creates a payout.
const bonusAccrual = createVerificationBonusAccrual({ pool })
const bonusPayouts = createVerificationBonusPayouts({ pool, connection })
let bonusAccrualTask=null,nextBonusAccrualCheck=0
async function observeVerificationBonuses(){
  try{const r=await bonusAccrual.runOnce();if(r.length)console.log(JSON.stringify({verificationBonusAccrual:r}))}
  catch(error){console.log(JSON.stringify({verificationBonusError:['42P01','42703'].includes(error?.code)?'VERIFICATION_BONUS_NOT_MIGRATED'
    :{code:error?.code??null,message:String(error?.message??'VERIFICATION_BONUS_ACCRUAL_UNAVAILABLE').slice(0,120)}}))}
}
// The 15 s timeout starts after any backoff wait, so a short rate-limit pause never eats the request's own budget.
const timedFetch=(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})
const graduationFetches={primary:meter.fetchFor('primary',timedFetch),verification:verificationUrls.length?verificationFetch(timedFetch):null}
const graduationRPC=url=>new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,
  fetch:async(url,options)=>{
    const response=await graduationFetches[url===rpc?'primary':'verification'](url,options)
    if(!response.ok){await response.body?.cancel();throw Error(response.status===429?'RPC_RATE_LIMITED':'RPC_UNAVAILABLE')}
    return response
  }})
const graduation=createGraduationMonitor({pool,connection:graduationRPC(rpc),config,verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
// Stock-paired markets (docs/STOCK_QUOTES.md): graduation proof, DAMM swaps and fee checkpoints in the stock ledgers. Its own pass,
// so a long stock backlog never delays SOL graduation.
const stockGraduation=createStockGraduationMonitor({pool,connection:graduationRPC(rpc),config,verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
let stockGraduationTask=null,nextStockGraduationCheck=0
// Never rejects (stockGraduationPass), since it runs un-awaited beside the main loop.
async function observeStockGraduation(){if(await stockGraduationPass(stockGraduation))process.exitCode=1}
const operatingWallets=createOperatingWalletMonitor({pool,connections:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?[graduationRPC(rpc),graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL)]:[]})
let operatingWalletTask=null,nextOperatingWalletCheck=0
async function observeOperatingWallets(){
  try{console.log(JSON.stringify({operatingWallets:await operatingWallets.runOnce()}))}
  catch{console.log(JSON.stringify({operatingWalletError:'OPERATING_BALANCE_UNVERIFIED'}))}
}
let nextGraduationCheck=0,graduationTask=null
// The fork guard (src/repo-lineage.mjs): first commits and fork parents for markets launched before migration 0058 (and any
// repository whose first commit could not be read at launch), five a minute through the GitHub App.
const lineageBackfill=createLineageBackfill({pool})
let lineageTask=null,nextLineageCheck=0
async function observeLineage(){
  try{const r=await lineageBackfill.runOnce();if(r.length)console.log(JSON.stringify({lineageBackfill:r}))}
  catch(error){console.log(JSON.stringify({lineageBackfillError:error?.code==='42703'?'NOT_MIGRATED':'LINEAGE_BACKFILL_UNAVAILABLE'}))}
}
// Live chart trades (src/live-trades.mjs; docs/CHARTS_AND_RESPONSIVENESS.md, "Live trades"). Confirmed swaps arrive over the
// primary RPC's websocket and go on charts at once, marked confirming until finalized. Graduated markets' finalized DAMM swaps
// are read every 10 s (and as soon as a confirmed one should be final) instead of once per graduation pass over every market.
// Each can be turned off alone: LIVE_TRADES_ENABLED=false (the websocket), FAST_GRADUATED_TRADES_ENABLED=false (the 10 s reads,
// leaving graduated swaps to the graduation pass). Live reads pause while the primary provider backs off a rate limit.
const graduatedTrades=process.env.FAST_GRADUATED_TRADES_ENABLED==='false'?null:createGraduatedTradeIndexer({pool,connection:graduationRPC(rpc),
  verification:process.env.GRADUATION_VERIFICATION_RPC_URL?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
const liveTrades=once||process.env.LIVE_TRADES_ENABLED==='false'?null:createLiveTrades({pool,config,connect:()=>rpcConnection(rpc,'confirmed'),
  onDammSwap:repoId=>graduatedTrades?.wake(repoId),paused:()=>meter.backoff('primary')>0,track:fn=>meter.track('liveTrades',fn)})
let liveLoggedAt=0,livePrunedAt=0,graduatedSkipLogged=false
// Both never reject. Each runs on its own timer beside the main loop (and beside the other), so a slow pass anywhere never
// delays a finalized read, a subscription refresh or the two-minute expiry.
async function observeLiveTrades(){
  const result={}
  if(liveTrades){
    try{const refreshed=await liveTrades.refresh();if(refreshed)result.refreshed=refreshed}
    catch(error){result.refreshError=error?.code==='42P01'?'NOT_MIGRATED':'LIVE_REFRESH_UNAVAILABLE'}
  }
  if(Date.now()-livePrunedAt>=15000){
    livePrunedAt=Date.now()
    try{const pruned=await pruneLiveTrades(pool);if(pruned)result.pruned=pruned}
    catch(error){if(error?.code!=='42P01')result.pruneError='LIVE_PRUNE_UNAVAILABLE'}
  }
  if(liveTrades&&Date.now()-liveLoggedAt>=60000){liveLoggedAt=Date.now();result.stats=liveTrades.stats()}
  if(Object.keys(result).length)console.log(JSON.stringify({liveTrades:result}))
}
async function observeGraduatedTrades(){
  if(!graduatedTrades)return
  try{
    const results=await graduatedTrades.runOnce()
    const skipped=results.some(item=>item.status==='SKIPPED')
    const shown=results.filter(item=>item.status==='INDEXED'||item.status==='ERROR'||(item.status==='SKIPPED'&&!graduatedSkipLogged))
    graduatedSkipLogged=skipped
    if(shown.length)console.log(JSON.stringify({graduatedTrades:shown}))
  }catch{console.log(JSON.stringify({graduatedTrades:[{status:'ERROR',code:'GRADUATED_TRADES_UNAVAILABLE'}]}))}
}
const chartOrdering=createChartOrdering({pool,connection:graduationRPC(rpc),verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})
let chartOrderingTask=null,nextChartOrderingCheck=0
async function observeChartOrdering(){
  try{console.log(JSON.stringify({chartOrdering:await chartOrdering.runOnce()}))}
  catch{console.log(JSON.stringify({chartOrderingError:'Chart ordering verification unavailable'}))}
}
// Stock-paired markets: their fee ledgers and each stock's custody against the chain (src/stock-reconcile.mjs). Read-only. A real
// mismatch raises a RECONCILIATION_MISMATCH operator alert at once; ledger lag only if it lasts STOCK_RECONCILE_LAG_MS. A custody
// surplus is informational (STOCK_CUSTODY_SURPLUS, once per amount).
const stockReconcile=createStockReconcileRunner({pool,connection:graduationRPC(rpc),config})
let stockReconcileTask=null,nextStockReconcileCheck=0
async function observeStockReconcile(){
  try{
    const r=await meter.track('stockReconcile',()=>stockReconcile.runOnce())
    if(r.markets.length||r.custody.length)console.log(JSON.stringify({stockReconcile:r}))
    if([...r.markets,...r.custody].some(item=>(item.alert&&item.status!=='SURPLUS')||item.status==='ERROR'))process.exitCode=1
  }catch(error){console.log(JSON.stringify({stockReconcileError:error?.code==='42P01'?'STOCK_LEDGERS_NOT_MIGRATED':'STOCK_RECONCILE_UNAVAILABLE'}))}
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
// Stock-pair fee collections and launcher payouts (docs/STOCK_QUOTES.md, "Execution (off by default)"): the worker only finishes
// rows scripts/stock-execute.mjs already signed (settle, rebroadcast, abort) and holds no key. null, so nothing is built, read or
// printed, unless STOCK_COLLECTIONS_EXECUTION_ENABLED or STOCK_LAUNCHER_PAYOUTS_ENABLED is 'true'.
const stockExecution=createStockExecutionJob({pool,config,connect:()=>({connection:graduationRPC(rpc),verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})})
let stockExecutionTask=null,nextStockExecutionCheck=0
async function observeStockExecution(){
  try{
    const r=await meter.track('stockExecution',()=>stockExecution.runOnce())
    if(r.collections.length||r.payouts.length)console.log(JSON.stringify({stockExecution:r}))
    if(stockExecutionLoud(r))process.exitCode=1
  }catch(error){console.log(JSON.stringify({stockExecutionError:String(error?.message??'STOCK_EXECUTION_UNAVAILABLE').slice(0,200)}));process.exitCode=1}
}
// Public "new market launched" posts to Telegram/X. Off unless LAUNCH_ALERTS_ENABLED=true, LAUNCH_ALERTS_SINCE and a
// channel's credentials are set; silent when off. Posts are claimed in launch_alerts before sending (never twice).
// When on, one startup line names what was picked up (no secrets), so a go-live can be confirmed before the first post.
// Model markets (HF_MARKETS_ENABLED=true here too) add one quick, display-only Hugging Face read per model post.
const alertsOn=config=>({channels:config.channels,since:config.since,maxPerDay:config.maxPerDay,models:config.models})
let launchAlerts=null,launchAlertTask=null,nextLaunchAlertCheck=0
try{
  const launchAlertConfig=launchAlertsConfig()
  if(launchAlertConfig){
    launchAlerts=createLaunchAlerts({store:createLaunchAlertStore(pool),config:launchAlertConfig,senders:createLaunchAlertSenders(launchAlertConfig),excluded:promotionExcluded,
      modelFacts:launchAlertConfig.models?createModelAlertFacts():null})
    console.log(JSON.stringify({launchAlertsOn:alertsOn(launchAlertConfig)}))
  }
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
  if(milestoneAlertConfig){
    milestoneAlerts=createMilestoneAlerts({store:createMilestoneAlertStore(pool),config:milestoneAlertConfig,senders:createLaunchAlertSenders(milestoneAlertConfig),excluded:promotionExcluded})
    console.log(JSON.stringify({milestoneAlertsOn:alertsOn(milestoneAlertConfig)}))
  }
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
// Dev Pulse reads public GitHub activity with the GitHub App's installation token (read-only metadata); it stays off
// without that token or with DEV_PULSE_ENABLED=false. Do-not-promote and opted-out repositories are never read.
const devPulse=process.env.DEV_PULSE_ENABLED!=='false'&&process.env.GITHUB_APP_PRIVATE_KEY_BASE64&&process.env.GITHUB_APP_INSTALLATION_ID
  ?createDevPulseCollector({pool,excluded:promotionExcluded}):null
if(!devPulse)console.log(JSON.stringify({devPulse:'disabled'}))
let devPulseTask=null,nextDevPulseCheck=0
async function observeDevPulse(){
  try{console.log(JSON.stringify({devPulse:await devPulse.runOnce()}))}
  catch(error){console.log(JSON.stringify({devPulseError:String(error?.message??'DEV_PULSE_UNAVAILABLE').slice(0,120)}))}
}
let reserveDelivery=null,reserveDeliveryTask=null,nextReserveDeliveryCheck=0
if(process.env.RESERVE_ALERTS_ENABLED==='true'){
  try{reserveDelivery=createReserveAlertDelivery({pool,send:createReserveWebhookSender(),reserveMoves:process.env.RESERVE_MOVE_NOTIFICATIONS==='true'})}
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
// Attribute every job's RPC calls in the usage line (byJob); calls outside a job count as "other". Launch and
// milestone alerts read only PostgreSQL and post to Telegram/X; they are listed so any future chain read shows up.
for(const [job,worker] of Object.entries({launches,fees,stockFees,claims,allocations,discovery,liquidity,reinvest,platformFees,tipTransfers,tipExpiry,
  tipMonitor,partsFunds,chartOrdering,graduation,graduatedTrades,stockGraduation,operatingWallets,buybackReceipts,tradeCanary,reminders,launchAlerts,milestoneAlerts})){
  if(!worker)continue
  const run=worker.runOnce;worker.runOnce=(...args)=>meter.track(job,()=>run.apply(worker,args))
}
const stopUsageReport=once?null:meter.report(60_000)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if(!once)for(const observe of [observeLiveTrades,observeGraduatedTrades]){
  const tick=()=>{void observe().catch(()=>{}).finally(()=>setTimeout(tick,2000))};tick()
}
async function observeGraduation(){
  const result={},startedAt=Date.now()
  try{result.graduation=await graduation.runOnce()}catch{result.graduationError='Graduation readiness unavailable'}
  // How long a pass took: public progress expires 300 s after a market's last verified pass (see GRADUATION_MARKET_PAUSE_MS).
  result.graduationMs=Date.now()-startedAt
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
    // Pasted payout addresses whose 48-hour hold has passed become the binding every payout path reads (database only;
    // the claim path also does this under its own lock). Before the migration reaches this database there are none.
    try {
      const activations = (await activateDuePayoutAddresses(pool)).filter(item => item.status !== 'none')
      if (activations.length) result.payoutAddresses = activations.map(({ status, repoId, requestId }) => ({ status, repoId, requestId }))
    }
    catch (error) { if (!['42P01', '42703'].includes(error?.code)) result.payoutAddressError = 'Payout address activation unavailable' }
    try { result.allocations = await allocations.runOnce() }
    catch { result.allocationError = 'Allocation recovery unavailable' }
    try { result.fees = await fees.runOnce() }
    catch (error) { result.feeError = error.message }
    try { result.stockFees = await stockFees.runOnce() }
    catch (error) { result.stockFeeError = error.message }
    try { result.discovery = await discovery.runOnce() }
    catch { result.discoveryError = 'Discovery recovery unavailable' }
    try { const bonusPayoutResults = await bonusPayouts.runOnce(); if (bonusPayoutResults.length) result.verificationBonusPayouts = bonusPayoutResults }
    catch (error) { if (!['42P01', '42703'].includes(error?.code)) result.verificationBonusPayoutError = 'Verification bonus payout recovery unavailable' }
    if(once)await observeVerificationBonuses()
    else if(!bonusAccrualTask&&Date.now()>=nextBonusAccrualCheck)
      bonusAccrualTask=observeVerificationBonuses().finally(()=>{nextBonusAccrualCheck=Date.now()+60000;bonusAccrualTask=null})
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
    if(!once&&!lineageTask&&Date.now()>=nextLineageCheck)
      lineageTask=observeLineage().finally(()=>{nextLineageCheck=Date.now()+60000;lineageTask=null})
    if(once)await observeGraduation()
    else if(!graduationTask&&Date.now()>=nextGraduationCheck)
      graduationTask=observeGraduation().finally(()=>{nextGraduationCheck=Date.now()+30000;graduationTask=null})
    if(once)await observeStockReconcile()
    else if(!stockReconcileTask&&Date.now()>=nextStockReconcileCheck)
      stockReconcileTask=observeStockReconcile().finally(()=>{nextStockReconcileCheck=Date.now()+STOCK_RECONCILE_INTERVAL_MS;stockReconcileTask=null})
    if(once)await observeStockGraduation()
    else if(!stockGraduationTask&&Date.now()>=nextStockGraduationCheck)
      stockGraduationTask=observeStockGraduation().finally(()=>{nextStockGraduationCheck=Date.now()+30000;stockGraduationTask=null})
    if(process.env.TREND_INTAKE_ENABLED==='true'){
      if(once)await observeTrends()
      else if(!trendTask&&Date.now()>=nextTrendCheck)trendTask=observeTrends().finally(()=>{nextTrendCheck=Date.now()+300000;trendTask=null})
    }
    // GitHub reads are paced by each repository's own schedule; a run checks at most 12 due repositories.
    if(devPulse){
      if(once)await observeDevPulse()
      else if(!devPulseTask&&Date.now()>=nextDevPulseCheck)
        devPulseTask=observeDevPulse().finally(()=>{nextDevPulseCheck=Date.now()+120000;devPulseTask=null})
    }
    if(once)await observeBuybackReceipts()
    else if(!buybackReceiptTask&&Date.now()>=nextBuybackReceiptCheck)
      buybackReceiptTask=observeBuybackReceipts().finally(()=>{nextBuybackReceiptCheck=Date.now()+180000;buybackReceiptTask=null})
    if(stockExecution){
      if(once)await observeStockExecution()
      else if(!stockExecutionTask&&Date.now()>=nextStockExecutionCheck)
        stockExecutionTask=observeStockExecution().finally(()=>{nextStockExecutionCheck=Date.now()+STOCK_EXECUTION_INTERVAL_MS;stockExecutionTask=null})
    }
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
      if (['error', 'reason', 'launchError', 'feeError', 'stockFeeError'].includes(key) && typeof value === 'string') return 'Indexer error'
      return value
    }))
    if (result.tipError || result.tipTransfers?.some(item => item.status === 'review') || result.tips?.some(item => item.state === 'review') || result.reinvestError || result.reinvest?.some(item => item.status === 'review') || result.liquidityError || result.liquidity?.some(item => item.status === 'review') || result.platformFeeError || result.platformFees?.some(item => item.status === 'review' || item.status === 'error') || result.allocationError || result.allocations?.some(item => item.status === 'review') || result.launchError || result.feeError || result.claimError || result.claims?.some(item => item.status === 'review') || result.discoveryError || result.discovery?.some(item => item.status === 'review') ||
        result.launches?.some(item => ['invalid', 'mismatch', 'missing', 'unavailable'].includes(item.state)) ||
        result.fees?.some(item => item.status === 'ERROR')) process.exitCode = 1
    if (result.verificationBonusPayoutError || result.verificationBonusPayouts?.some(item => item.status === 'review')) process.exitCode = 1
    if (result.payoutAddressError || result.payoutAddresses?.some(item => item.status === 'error')) process.exitCode = 1
    if (result.stockFeeError || result.stockFees?.some(item => item.status === 'ERROR')) process.exitCode = 1
    if (!once) await delay(5000)
  } while (!once)
} finally { if(stockReconcileTask)await stockReconcileTask;if(bonusAccrualTask)await bonusAccrualTask;if(devPulseTask)await devPulseTask;if(launchAlertTask)await launchAlertTask;if(milestoneAlertTask)await milestoneAlertTask;if(partsTask)await partsTask;if(tipMonitorTask)await tipMonitorTask;if(tradeCanaryTask)await tradeCanaryTask;if(buybackReceiptTask)await buybackReceiptTask;if(operatingWalletTask)await operatingWalletTask;if(reminderTask)await reminderTask;if(graduationTask)await graduationTask;if(stockGraduationTask)await stockGraduationTask;if(chartOrderingTask)await chartOrderingTask;if(trendTask)await trendTask;if(reserveDeliveryTask)await reserveDeliveryTask;if(stockExecutionTask)await stockExecutionTask;await pool.end()
  stopUsageReport?.();const usage=meter.flush();if(usage)console.log(JSON.stringify(usage)) }
