// Deployment composition point. No environment keys, test fixtures, or implicit
// activation. An operator-reviewed server bootstrap must install a complete runtime.
let runtime=null
export function installNativeLaunchRuntime(value){
 if(runtime||!value||value.ownerCustodyApproved!==true||value.operatorDeploymentApproved!==true||value.economicsApproved!==true
  ||typeof value.reserve!=='function'||!value.lifecycle)throw Error('Complete approved launcher configuration required')
 runtime=Object.freeze(value)
}
export function nativeLaunchRuntime(){return runtime}
// The production bootstrap shares the identity HTTP database configuration. The
// lower-level factory remains injectable for disposable local integration tests.
export async function initializeNativeLaunchRuntime({settings,env=process.env}={}){
 let pool
 try{
  if(runtime||env.HOOK_NATIVE_LAUNCH_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')throw Error()
  const [{default:pg},{walletIdentityConfiguration},{createNativeLaunchRuntime}]=await Promise.all([
   import('pg'),import('./hooklab-wallet-identity.mjs'),import('../../src/hooklab-native-launch-runtime.mjs')])
  const identity=walletIdentityConfiguration(env)
  if(settings.origin!==identity.origin)throw Error()
  pool=new pg.Pool({connectionString:identity.databaseUrl,max:10,connectionTimeoutMillis:5000,query_timeout:15000})
  const configured=createNativeLaunchRuntime(pool,settings)
  installNativeLaunchRuntime(configured)
  return configured
 }catch{await pool?.end().catch(()=>{});throw Error('Complete approved launcher configuration unavailable')}
}
