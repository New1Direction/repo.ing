// Server-only startup for the isolated local acceptance process. No production keys.
import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { createPrivateKey, sign } from 'node:crypto'
import { createNativeLaunchRuntime } from '../src/hooklab-native-launch-runtime.mjs'
import { installNativeLaunchRuntime, nativeLaunchRuntime } from '../app/lib/hooklab-native-launch-runtime.mjs'
import { createInclusiveTradeRuntime, installInclusiveTradeRuntime } from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import { LOCAL_PROFILE_SCHEMA, LOCAL_DOSSIER_SCHEMA, localAcceptanceNetwork } from '../src/hooklab-local-acceptance.mjs'
import { localArtifacts, localKey, pda, pk, sha, loader, stateDirectory } from './hooks-local-common.mjs'
import { createLocalOperationsRuntime } from './hooks-local-operations.mjs'
import { createLocalLaunchLookupTable } from './hooks-local-launch-tables.mjs'
export async function bootstrapLocalHooks() {
  const network=localAcceptanceNetwork();if(!network)throw Error('Explicit local acceptance configuration required')
  if(nativeLaunchRuntime())return
  const state=stateDirectory(),chain=JSON.parse(await readFile(`${state}/local-chain.public.json`,'utf8')),bundle=await localArtifacts()
  if(chain.genesisHash!==network.genesisHash)throw Error('Retained local genesis differs')
  const providers=['local-a','local-b'],connections=network.endpoints.map((endpoint,i)=>({provider:providers[i],connection:new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true})}))
  if((await Promise.all(connections.map(x=>x.connection.getGenesisHash()))).some(hash=>hash!==network.genesisHash))throw Error('Actual local RPC genesis differs')
  const profileJson=JSON.stringify({...bundle.profile,schema:LOCAL_PROFILE_SCHEMA,profileId:`local-${network.genesisHash.slice(0,16)}`,genesisHash:network.genesisHash})
  async function collectOperatorBindings(){
  const profile={json:profileJson,expectedSha256:sha(profileJson),providers,idls:Object.fromEntries(Object.entries(bundle.idls).map(([role,bytes])=>[role,Buffer.from(bytes).toString('base64')])),
   elfLengths:Object.fromEntries(Object.entries(bundle.artifacts.artifacts).map(([role,a])=>[role,a.elfLength]))}
  const programs=[]
  for(const role of ['launch','swap','gate','token']){
   const address=bundle.profile.programs[role],programData=pda(loader,pk(address).toBuffer()),observed=await connections[0].connection.getAccountInfo(pk(programData),'finalized')
   const bytes=observed?.data,length=role==='token'?326504:profile.elfLengths[role],expected=role==='token'?bundle.profile.dependencyObservation.tokenElfSha256:bundle.profile.elfSha256[role]
   if(!bytes||sha(bytes.subarray(45,45+length))!==expected)throw Error('Actual local program ELF differs from the reviewed build')
   programs.push({role,address,programData,upgradeAuthority:bytes[12]?pk(bytes.subarray(13,45)).toBase58():null,deploySlot:Number(bytes.readBigUInt64LE(4)),programDataSha256:sha(bytes),elfLength:length,elfSha256:expected})
  }
  const addresses={'launch-config':pda(bundle.profile.programs.launch,'config'),'swap-config':pda(bundle.profile.programs.swap,'config'),
   'creation-control':pda(bundle.profile.programs.launch,'governance'),'swap-governance':pda(bundle.profile.programs.swap,'governance'),'quote-mint':bundle.profile.quoteMint}
  const accounts=[]
  for(const [role,address]of Object.entries(addresses)){
   const account=await connections[0].connection.getAccountInfo(pk(address),'finalized');if(!account)throw Error('Local shared account missing')
   accounts.push({role,address,owner:account.owner.toBase58(),executable:account.executable,dataSha256:sha(account.data),...(['launch-config','swap-config'].includes(role)
    ?{binding:'config-counters-v1',approvedDataBase64:account.data.toString('base64'),idlSha256:sha(bundle.idls[role.split('-')[0]])}:{})})
  }
  const dossierJson=JSON.stringify({schema:LOCAL_DOSSIER_SCHEMA,topology:network.topology,genesisHash:network.genesisHash,
   artifacts:{sourceCommit:bundle.profile.sourceCommit,profileSha256:profile.expectedSha256,sdkSha256:sha(await readFile(new URL('../package-lock.json',import.meta.url))),
    idlSha256:sha(Object.values(bundle.idls).join('')),provenanceSha256:sha('LOCAL ONLY app d3eb0df2701be2b77e624d60750b99bc8bb23ebe protocol 134e16de1aadeac921bb314284fd3fd181c86097')},
   providers,minSlot:await connections[0].connection.getSlot('finalized'),maxSlotLag:5,maxAgeMs:60000,programs,accounts})
  const lc=bundle.coders.launch.accounts.decode('Config',Buffer.from(accounts.find(a=>a.role==='launch-config').approvedDataBase64,'base64'))
  const sc=bundle.coders.swap.accounts.decode('Config',Buffer.from(accounts.find(a=>a.role==='swap-config').approvedDataBase64,'base64'))
  const table=await connections[0].connection.getAccountInfo(pk(chain.lookupTable),'finalized');if(!table)throw Error('Local lookup table missing')
  const config={schema:'repoing/inclusive-max-wallet-operator-config/1',feeModel:2,enabled:true,approvalReference:'USER-AUTHORIZED-DISPOSABLE-LOCAL-ACCEPTANCE-NOT-PRODUCTION',
   profileSha256:profile.expectedSha256,dossierSha256:sha(dossierJson),providerTrustDomains:providers.map((provider,i)=>({provider,trustDomain:'single-local-validator',origin:`${network.endpoints[i]}/`})),
   economics:{creatorFeeBps:100,authorShareBps:0,lpFeeBps:lc.lp_fee_bps,maxCreatorFeeBps:lc.max_creator_fee_bps,protocolFeeBps:sc.protocol_fee_bps,launchProtocolShareBps:sc.launch_protocol_share_bps,
    launchFeeLamports:lc.launch_fee_lamports.toString(),poolCreationFeeLamports:sc.pool_creation_fee_lamports.toString()},reviewer:chain.roles.admin,treasury:chain.roles.collector,
   lookupTable:{address:chain.lookupTable,sha256:sha(table.data)},lamportsPerSignature:'5000'}
  return {schema:'repoing/local-operator-bundle/1',genesisHash:network.genesisHash,profile,config,dossierJson}
  }
  const operatorPath=`${state}/local-operator-bundle.public.json`
  let operator
  try{operator=JSON.parse(await readFile(operatorPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  if(!operator){operator=await collectOperatorBindings();await writeFile(operatorPath,JSON.stringify(operator),{mode:0o600,flag:'wx'})}
  const {profile,config,dossierJson}=operator
  if(operator.schema!=='repoing/local-operator-bundle/1'||operator.genesisHash!==network.genesisHash||profile.json!==profileJson
   ||profile.expectedSha256!==sha(profileJson)||config.profileSha256!==profile.expectedSha256||config.dossierSha256!==sha(dossierJson)
   ||config.reviewer!==chain.roles.admin||config.treasury!==chain.roles.collector)throw Error('Retained local operator approval differs; preserve pending operations instead of replacing it')
  const pool=new pg.Pool({connectionString:process.env.HOOK_WALLET_IDENTITY_DATABASE_URL,max:10})
  const key=await readFile(`${state}/local-custody-key.bin`);if(key.length!==32)throw Error('Local encryption key is unavailable')
  const admin=localKey('admin'),privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(admin.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'})
  const base={enabled:true,origin:network.origin,ownerCustodyApproved:true,operatorDeploymentApproved:true,economicsApproved:true,config,profile,dossierJson,connections,
   keyRing:{'local-only':key},activeKeyId:'local-only',adminSigner:{address:chain.roles.admin,sign:message=>new Uint8Array(sign(null,message,privateKey))},
   launchLookupTable:createLocalLaunchLookupTable({pool,profile,chain,state})}
  async function reviewTiming(){
   const slot=await connections[0].connection.getSlot('confirmed'),now=Date.now()
   return {nowMs:now,validUntilSlot:slot+96,reviewExpiresAtMs:now+60000}
  }
  async function launchSettings(){
   const common={...await reviewTiming(),maxAgeMs:60000,maxSlotLag:5,maxNetworkFeeLamports:'20000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}
   return {...base,reviewTiming,preparationLimits:{...common,maxRentLamports:'20000000',maxTotalDebitLamports:'20020000'},
    launchLimits:{...common,maxLaunchFeeLamports:'0',maxPoolCreationFeeLamports:'0',maxRentLamports:'100000000',maxInstructionDebitLamports:'100000000',maxTotalDebitLamports:'100020000'}}
  }
  const native=createNativeLaunchRuntime(pool,await launchSettings())
  installNativeLaunchRuntime({...native,async reserve(input){return createNativeLaunchRuntime(pool,await launchSettings()).reserve(input)}})
  const trading=createInclusiveTradeRuntime(pool,{...base,ownerTradingApproved:true,limits:{nowMs:Date.now(),maxAgeMs:60000,maxSlotLag:5,validUntilSlot:0,reviewExpiresAtMs:0,
   maxNetworkFeeLamports:'5000',maxTotalDebitLamports:'5000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}})
  installInclusiveTradeRuntime(trading)
  globalThis[Symbol.for('repo.ing.hooklab.local-operations')]=createLocalOperationsRuntime({pool,base,bundle,chain,privateKey})
  console.log(`LOCAL Hook Lab runtimes installed: ${network.origin}; real validator ${network.genesisHash}; mainnet submission blocked`)
}
