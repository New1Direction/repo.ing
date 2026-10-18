// Server bootstrap only. Never reads keys/endpoints from requests or activates itself.
import {nativeSigningLifecycle} from '../../src/hooklab-native-signing.mjs'
import {nativeTransactionSender} from '../../src/hooklab-native-transaction-sender.mjs'
import {inclusiveTradeResolver} from '../../src/hooklab-inclusive-trade-resolver.mjs'
import { isLocalExecutionDossier } from '../../src/hooklab-local-acceptance.mjs'
const runtimeKey=Symbol.for('repo.ing.hooklab.inclusive-trade-runtime')
export function createInclusiveTradeRuntime(pool,{origin,ownerTradingApproved=false,operatorDeploymentApproved=false,economicsApproved=false,
 config,profile,dossierJson,connections,limits}={}){
 if(!ownerTradingApproved||!operatorDeploymentApproved||!economicsApproved)throw Error('Complete explicit trade adoption required')
 const dossier=JSON.parse(dossierJson)
 if((dossier.schema!=='repoing/production-observation/2'&&!isLocalExecutionDossier(dossier))||!['launch-config','swap-config'].every(role=>dossier.accounts.some(pin=>pin.role===role&&pin.binding==='config-counters-v1')))throw Error('Counter-aware approved trading dossier required')
 const resolver=inclusiveTradeResolver({config,profile,dossierJson,connections,limits})
 const sender=nativeTransactionSender({enabled:true,connections})
 const lifecycle=nativeSigningLifecycle(pool,{enabled:true,origin,resolver,sender,custodyAdapter:null,
  stageOperations:{'inclusive-buy':'inclusive-max-wallet-buy','inclusive-sell':'inclusive-max-wallet-sell'}})
 return Object.freeze({origin,genesisHash:JSON.parse(profile.json).genesisHash,ownerTradingApproved:true,operatorDeploymentApproved:true,economicsApproved:true,lifecycle})
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
  const configured=createInclusiveTradeRuntime(pool,settings);installInclusiveTradeRuntime(configured);return configured
 } catch {await pool?.end().catch(()=>{});throw Error('Complete approved trading configuration unavailable')}
}
