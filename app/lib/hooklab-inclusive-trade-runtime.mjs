// Server bootstrap only. Never reads keys/endpoints from requests or activates itself.
import {nativeSigningLifecycle} from '../../src/hooklab-native-signing.mjs'
import {nativeTransactionSender} from '../../src/hooklab-native-transaction-sender.mjs'
import {inclusiveTradeResolver} from '../../src/hooklab-inclusive-trade-resolver.mjs'
import {nativeTradeResolver} from '../../src/hooklab-native-trade-resolver.mjs'
import {pinsNativeBuilds} from '../../src/hooklab-native-swap.mjs'
import {provenFinalizedProgress} from '../../src/hooklab-blockhash-proof.mjs'
import {stagedResolver,walletFundingResolver} from '../../src/hooklab-wallet-funding-resolver.mjs'
import {readHookCoinMarket,readHookWalletBalances} from '../../src/hooklab-coin-market.mjs'
import {ownerApprovalStore} from '../../src/hooklab-owner-approval.mjs'
import {hookActivityRpc} from '../../src/hooklab-coin-activity.mjs'
import { isLocalExecutionDossier } from '../../src/hooklab-local-acceptance.mjs'
import { coinStack, isStackProfile } from '../../src/hooklab-stack.mjs'
const runtimeKey=Symbol.for('repo.ing.hooklab.inclusive-trade-runtime')
// Withdrawing SOL from Hook Lab (unwrap) is always available, and every funding operation stays readable, so customers
// can never be left with SOL they cannot take out. walletFundingEnabled only allows starting new deposits (wrap).
// nativeTradingEnabled (HOOK_NATIVE_TRADING_ENABLED, off by default) opens the native-SOL stages to new trades for coins whose pool and
// launch are native; it needs the upgraded programs, a bundle pinning them (else it stays off) and the native-stages migration.
// Two stacks: config/profile/dossierJson are bundle 2's (the legacy stack: the canary, bridged trades, Add SOL and Withdraw);
// stack, when given, is our own stack's bundle ({config,profile,dossierJson}), which serves every native trade. Each coin is
// read and traded under its own stack's bundle (src/hooklab-stack.mjs coinStack), and every check stays exact per stack.
export function createInclusiveTradeRuntime(pool,{origin,ownerTradingApproved=false,operatorDeploymentApproved=false,economicsApproved=false,
 config,profile,dossierJson,connections,limits,walletFundingEnabled=false,nativeTradingEnabled=false,openLaunches=false,stack=null}={}){
 if(!ownerTradingApproved||!operatorDeploymentApproved||!economicsApproved)throw Error('Complete explicit trade adoption required')
 const counterAware=json=>{const dossier=JSON.parse(json);return (dossier.schema==='repoing/production-observation/2'||isLocalExecutionDossier(dossier))&&['launch-config','swap-config'].every(role=>dossier.accounts.some(pin=>pin.role===role&&pin.binding==='config-counters-v1'))}
 if(!counterAware(dossierJson)||(stack&&!counterAware(stack.dossierJson)))throw Error('Counter-aware approved trading dossier required')
 const profiles={legacy:JSON.parse(profile.json),own:stack?JSON.parse(stack.profile.json):null}
 if(isStackProfile(profiles.legacy)||(stack&&!isStackProfile(profiles.own)))throw Error('The legacy bundle and our stack\'s bundle are each required in their place')
 if(stack&&['launch','swap','gate','token'].some(role=>Object.values(profiles.legacy.programs).includes(profiles.own.programs[role])))throw Error('Our stack must not share a program with the legacy stack')
 const trade=inclusiveTradeResolver({config,profile,dossierJson,connections,limits})
 const funding=walletFundingResolver({config,profile,dossierJson,connections,limits})
 // Native trades: our own stack's bundle when installed (every new coin), else a native bundle on the legacy programs.
 // Native stays off, never throws, when the bundle does not pin native builds: bridged trades and withdrawals keep working.
 const nativeBundle=stack??{config,profile,dossierJson}
 const nativeOpen=nativeTradingEnabled===true&&pinsNativeBuilds(nativeBundle.profile)
 const native=nativeTradeResolver({...nativeBundle,connections,limits})
 const sender=nativeTransactionSender({enabled:true,connections})
 const lifecycle=nativeSigningLifecycle(pool,{enabled:true,origin,sender,custodyAdapter:null,...tradeLifecycleSettings({trade,funding,native,nativeOpen,connections})})
 // The coin's stack profile (programs, quote marker): server-side only, never sent to a customer.
 const profileFor=coin=>coinStack(coin)==='own'?profiles.own:profiles.legacy
 // Display-only market reads use the primary provider; trades and funding re-verify on both providers. coin: the listed
 // coin record (its stack); looked up when not given. A coin whose stack has no bundle here reads as not listed.
 const market=async(mint,wallet=null,coin)=>{
  const record=coin===undefined?await approvals.coinByMint(mint):coin,stackProfile=profileFor(record)
  return stackProfile?readHookCoinMarket({connection:connections[0].connection,mint,wallet,profile:stackProfile}):null
 }
 // Bridged SOL exists on the legacy stack only (Add SOL and Withdraw for its holders).
 const walletBalances=wallet=>readHookWalletBalances({connection:connections[0].connection,wallet,profile:profiles.legacy})
 // Only coins launched through the site are shown; a test coin or anything launched outside the site is not. With open
 // launches the coin also carries its moderation state (a delisted coin's page shows the notice and offers no BUY).
 const approvals=ownerApprovalStore(pool,{adminAddress:config.reviewer,openLaunches}),coinProfile=mint=>approvals.coinByMint(mint)
 // The coin page's chart, trades and holders read the same primary provider (src/hooklab-coin-activity.mjs): reads only,
 // under the coin's stack (activity: the legacy stack's, for callers that predate stacks).
 const activityFor=coin=>{const stackProfile=profileFor(coin);return stackProfile?hookActivityRpc(connections[0].connection,{programs:stackProfile.programs}):null}
 const activity=hookActivityRpc(connections[0].connection,{programs:profiles.legacy.programs})
 return Object.freeze({origin,genesisHash:profiles.legacy.genesisHash,ownerTradingApproved:true,operatorDeploymentApproved:true,economicsApproved:true,walletFunding:walletFundingEnabled===true,walletWithdraw:true,
  nativeTrading:nativeOpen,lifecycle,market,walletBalances,coinProfile,profileFor,activity,activityFor})
}
// The trade lifecycle's resolvers and stages: bridged trades and funding, and native trades. The native stages are always
// registered, so a sent native trade stays readable and settles whatever the switch says; while native trading is off
// they are closed to new work (review, refresh, wallet request, send). connections: the runtime's two providers, which
// prove a never-sent operation's blockhash expired before expire() closes it (none: expire() is unavailable).
export function tradeLifecycleSettings({trade,funding,native,nativeOpen,connections=null}){
 return {resolver:stagedResolver({'inclusive-buy':trade,'inclusive-sell':trade,'wallet-fund':funding,'wallet-withdraw':funding,'native-buy':native,'native-sell':native}),
  stageOperations:{'inclusive-buy':'inclusive-max-wallet-buy','inclusive-sell':'inclusive-max-wallet-sell','wallet-fund':'hooklab-wallet-fund','wallet-withdraw':'hooklab-wallet-withdraw',
   'native-buy':'native-max-wallet-buy','native-sell':'native-max-wallet-sell'},
  closedStages:nativeOpen?[]:['native-buy','native-sell'],expiryObserver:connections?()=>provenFinalizedProgress(connections):null}
}
export function installInclusiveTradeRuntime(value){
 if(inclusiveTradeRuntime()||!value||value.ownerTradingApproved!==true||value.operatorDeploymentApproved!==true||value.economicsApproved!==true||!value.lifecycle)throw Error('Complete approved trading runtime required')
 globalThis[runtimeKey]=Object.freeze(value)
}
export function inclusiveTradeRuntime(){return globalThis[runtimeKey]??null}

// Production bootstrap uses the wallet-session database, never an unrelated pool.
export async function initializeInclusiveTradeRuntime({settings,env=process.env}={}) {
 let pool
 try {
  if(inclusiveTradeRuntime()||env.HOOK_INCLUSIVE_TRADING_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')throw Error()
  const [{createHookLabDatabasePool},{walletIdentityConfiguration}]=await Promise.all([import('../../src/hooklab-database.mjs'),import('./hooklab-wallet-identity.mjs')])
  const identity=walletIdentityConfiguration(env);if(settings.origin!==identity.origin)throw Error()
  pool=createHookLabDatabasePool(identity,10,'runtime')
  const configured=createInclusiveTradeRuntime(pool,{...settings,nativeTradingEnabled:env.HOOK_NATIVE_TRADING_ENABLED==='true'});installInclusiveTradeRuntime(configured);return configured
 } catch {await pool?.end().catch(()=>{});throw Error('Complete approved trading configuration unavailable')}
}
