// Deployment composition point. No environment keys, test fixtures, or implicit
// activation. An operator-reviewed server bootstrap must install a complete runtime.
// Next instrumentation and route bundles must share the same process installation.
const runtimeKey=Symbol.for('repo.ing.hooklab.native-launch-runtime')
export function installNativeLaunchRuntime(value){
 if(nativeLaunchRuntime()||!value||value.ownerCustodyApproved!==true||value.operatorDeploymentApproved!==true||value.economicsApproved!==true
  ||typeof value.reserve!=='function'||!value.lifecycle)throw Error('Complete approved launcher configuration required')
 globalThis[runtimeKey]=Object.freeze(value)
}
export function nativeLaunchRuntime(){return globalThis[runtimeKey]??null}
// The production bootstrap shares the identity HTTP database configuration. The
// lower-level factory remains injectable for disposable local integration tests.
export async function initializeNativeLaunchRuntime({settings,env=process.env}={}){
 let pool
 try{
  if(nativeLaunchRuntime()||env.HOOK_NATIVE_LAUNCH_ENABLED!=='true'||env.HOOK_WALLET_IDENTITY_ENABLED!=='true')throw Error()
  const [{createHookLabDatabasePool},{walletIdentityConfiguration},{createNativeLaunchRuntime}]=await Promise.all([
   import('../../src/hooklab-database.mjs'),import('./hooklab-wallet-identity.mjs'),import('../../src/hooklab-native-launch-runtime.mjs')])
  const identity=walletIdentityConfiguration(env)
  if(settings.origin!==identity.origin)throw Error()
  pool=createHookLabDatabasePool(identity,10,'runtime')
  const configured=createNativeLaunchRuntime(pool,settings)
  installNativeLaunchRuntime(configured)
  return configured
 }catch{await pool?.end().catch(()=>{});throw Error('Complete approved launcher configuration unavailable')}
}
