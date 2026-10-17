// Server bootstrap only. Never reads keys/endpoints from requests or activates itself.
import {nativeSigningLifecycle} from '../../src/hooklab-native-signing.mjs'
import {nativeTransactionSender} from '../../src/hooklab-native-transaction-sender.mjs'
import {inclusiveTradeResolver} from '../../src/hooklab-inclusive-trade-resolver.mjs'
let installed=null
export function createInclusiveTradeRuntime(pool,{origin,ownerTradingApproved=false,operatorDeploymentApproved=false,economicsApproved=false,
 config,profile,dossierJson,connections,limits}={}){
 if(!ownerTradingApproved||!operatorDeploymentApproved||!economicsApproved)throw Error('Complete explicit trade adoption required')
 const dossier=JSON.parse(dossierJson)
 if(dossier.schema!=='repoing/production-observation/2'||!['launch-config','swap-config'].every(role=>dossier.accounts.some(pin=>pin.role===role&&pin.binding==='config-counters-v1')))throw Error('Counter-aware approved trading dossier required')
 const resolver=inclusiveTradeResolver({config,profile,dossierJson,connections,limits})
 const sender=nativeTransactionSender({enabled:true,connections})
 const lifecycle=nativeSigningLifecycle(pool,{enabled:true,origin,resolver,sender,custodyAdapter:null,
  stageOperations:{'inclusive-buy':'inclusive-max-wallet-buy','inclusive-sell':'inclusive-max-wallet-sell'}})
 return Object.freeze({origin,genesisHash:JSON.parse(profile.json).genesisHash,ownerTradingApproved:true,operatorDeploymentApproved:true,economicsApproved:true,lifecycle})
}
export function installInclusiveTradeRuntime(value){
 if(installed||!value||value.ownerTradingApproved!==true||value.operatorDeploymentApproved!==true||value.economicsApproved!==true||!value.lifecycle)throw Error('Complete approved trading runtime required')
 installed=Object.freeze(value)
}
export function inclusiveTradeRuntime(){return installed}

// Production bootstrap uses the wallet-session database, never an unrelated pool.
export async function initializeInclusiveTradeRuntime({settings,env=process.env}={}) {
 let pool
 try {
  if(installed||env.HOOK_INCLUSIVE_TRADING_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')throw Error()
  const [{default:pg},{walletIdentityConfiguration}]=await Promise.all([import('pg'),import('./hooklab-wallet-identity.mjs')])
  const identity=walletIdentityConfiguration(env);if(settings.origin!==identity.origin)throw Error()
  pool=new pg.Pool({connectionString:identity.databaseUrl,max:10,connectionTimeoutMillis:5000,query_timeout:15000})
  const configured=createInclusiveTradeRuntime(pool,settings);installInclusiveTradeRuntime(configured);return configured
 } catch {await pool?.end().catch(()=>{});throw Error('Complete approved trading configuration unavailable')}
}
