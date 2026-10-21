// Read-only production operator bundle: the reviewed profile (with the owner's fee and cap menus),
// the production observation dossier, and the operator configuration the server validates at start.
// Two independent mainnet providers must return identical bytes for every account. It refuses unless
// the gate is immutable, every deployed program equals its reviewed pin, and both configs already
// carry the approved economics. It never signs, sends or reads secrets. The artifacts are bundle 2's
// unless given (bundle 3: src/hooklab-production-native-bundle.mjs). A local network is a dry run on a
// disposable validator: its bundle carries the local schemas, which production never accepts.
import { quoteMintSupplyBinding } from './hooklab-production-observer.mjs'
import { LOCAL_DOSSIER_SCHEMA,LOCAL_PROFILE_SCHEMA } from './hooklab-local-acceptance.mjs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { AddressLookupTableAccount,PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { sharedTradeAddresses } from './hooklab-owner-launch-tables.mjs'
import { tokenElfLengthOf } from './hooklab-stack.mjs'
import { openLaunchTableAddresses } from './hooklab-max-wallet-launch.mjs'
import { CREATOR_FEE_BPS_CHOICES,DEFAULT_CREATOR_FEE_BPS,WALLET_CAP_BPS_CHOICES,DEFAULT_WALLET_CAP_BPS,CREATOR_FEE_CEILING_BPS } from './hooklab-launch-menus.mjs'
import { selectedHookReleaseEvidenceSchema,validateSelectedHookReleaseBindings } from './hooklab-max-wallet-launch-collector.mjs'
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const pk=value=>new PublicKey(value)
const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),pk(program))[0].toBase58()
const refuse=message=>{throw Object.assign(Error(`Production bundle refused: ${message}`),{code:'PRODUCTION_BUNDLE_REFUSED'})}
const need=(ok,message)=>{if(!ok)refuse(message)}
const vendor=name=>readFileSync(new URL(`../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/${name}`,import.meta.url))

export function productionArtifacts(){
 const base=JSON.parse(vendor('offline-builder-profile.json')),build=JSON.parse(vendor('build-artifacts.json'))
 const idls={launch:vendor('bordrless_launch.json'),swap:vendor('bordrless_swap.json'),gate:vendor('hook_max_wallet.json')}
 for(const role of ['launch','swap','gate'])need(sha(idls[role])===base.idlSha256[role]&&build.artifacts[role].elfSha256===base.elfSha256[role],`${role} IDL or ELF pin differs from the reviewed profile`)
 need(base.genesisHash===MAINNET_GENESIS&&base.buildFeature==='inclusive-fees-candidate','reviewed profile is not the mainnet inclusive build')
 return {base,idls,elfLengths:{launch:build.artifacts.launch.elfLength,swap:build.artifacts.swap.elfLength,gate:build.artifacts.gate.elfLength},sdkSha256:sha(vendor('build-artifacts.json'))}
}
// The reviewed profile plus the owner-approved creator menus. Changing a menu changes this hash.
export function productionProfileJson(base){
 return JSON.stringify({...base,profileId:`production-menus-${base.profileId}`.slice(0,64),
  capability:{...base.capability,creatorFeeBps:DEFAULT_CREATOR_FEE_BPS,creatorFeeBpsChoices:[...CREATOR_FEE_BPS_CHOICES],
   capBpsChoices:[...WALLET_CAP_BPS_CHOICES],defaultCapBps:DEFAULT_WALLET_CAP_BPS}})
}

export const PRODUCTION_NETWORK=Object.freeze({genesisHash:MAINNET_GENESIS,local:false})
const LOOPBACK=['127.0.0.1','localhost','[::1]']
// The network a bundle is read from: mainnet, or (local: true) a disposable non-mainnet validator on loopback RPC only.
function checkedNetwork(network,connections){
 need(network&&typeof network.genesisHash==='string'&&typeof network.local==='boolean','network must name its genesis and whether it is local')
 if(!network.local)need(network.genesisHash===MAINNET_GENESIS,'a production bundle is read from mainnet only')
 else need(network.genesisHash!==MAINNET_GENESIS&&connections.every(c=>LOOPBACK.includes(new URL(c.connection.rpcEndpoint).hostname)),'a local dry run reads a non-mainnet validator on loopback RPC only')
 return network
}
// Every address from both providers, which must return identical bytes for each.
export async function readBoth(connections,addresses){
 const views=await Promise.all(connections.map(({connection})=>connection.getMultipleAccountsInfoAndContext(addresses.map(pk),'finalized')))
 return addresses.map((address,i)=>{
  const [a,b]=views.map(v=>v.value[i])
  need(a&&b,`${address} is missing on a provider`)
  need(a.owner.equals(b.owner)&&a.executable===b.executable&&Buffer.from(a.data).equals(Buffer.from(b.data)),`providers disagree on ${address}`)
  return {address,owner:a.owner.toBase58(),executable:a.executable,data:Buffer.from(a.data)}
 })
}

// connections: [{provider,connection}] for two independent providers (e.g. Helius, PublicNode)
// trustDomains: [{provider,trustDomain,origin}] reviewed by the operator, same order
// launchTable: the owner's shared launch table for open (self-serve) launches; required for the open-creation build, which
// is the only one with them. It must be frozen and hold exactly the constant addresses every open launch shares.
export async function collectProductionOperatorBundle({connections,trustDomains,lookupTable,launchTable=null,reviewer,treasury,approvalReference,artifacts=productionArtifacts(),network=PRODUCTION_NETWORK,selectedHookReleaseEvidence=null}){
 const openBuild=artifacts.build==='open-36dd07e'||artifacts.open===true
 need(openBuild===(launchTable!==null),openBuild?'the open-creation build needs the shared launch table (--launch-table)':'only the open-creation build takes a shared launch table')
 need(Array.isArray(connections)&&connections.length===2&&new Set(connections.map(c=>c.provider)).size===2,'two distinct providers required')
 const {genesisHash,local}=checkedNetwork(network,connections)
 const selected=selectedHookReleaseEvidence===null?null:selectedHookReleaseEvidenceSchema.parse(selectedHookReleaseEvidence)
 need(!selected||(!local&&openBuild),'selected hook release evidence is for production open stacks only')
 // A local validator is one trust domain behind two labelled endpoints.
 need(isDeepStrictEqual(connections.map(c=>c.provider),trustDomains.map(t=>t.provider))&&(local||new Set(trustDomains.map(t=>t.trustDomain)).size===2),'two independent reviewed trust domains required')
 for(const [i,{connection}] of connections.entries())need(new URL(connection.rpcEndpoint).origin===new URL(trustDomains[i].origin).origin,'provider origin differs from its reviewed trust domain')
 need((await Promise.all(connections.map(c=>c.connection.getGenesisHash()))).every(g=>g===genesisHash),local?'a provider is not the local validator':'a provider is not mainnet')
 const {base,idls,elfLengths,sdkSha256}=artifacts,P=base.programs,reviewedJson=productionProfileJson(base)
 const profileJson=local?JSON.stringify({...JSON.parse(reviewedJson),schema:LOCAL_PROFILE_SCHEMA,genesisHash}):reviewedJson
 const profile={json:profileJson,expectedSha256:sha(profileJson),providers:connections.map(c=>c.provider),
  idls:Object.fromEntries(Object.entries(idls).map(([role,bytes])=>[role,bytes.toString('base64')])),elfLengths}
 const programRoles=['launch','swap','gate','token'],programData=programRoles.map(role=>pda(LOADER,pk(P[role]).toBuffer()))
 const accountRoles={'launch-config':pda(P.launch,'config'),'swap-config':pda(P.swap,'config'),'creation-control':pda(P.launch,'governance'),'swap-governance':pda(P.swap,'governance'),'quote-mint':base.quoteMint}
 const selectedAddresses=selected?.hookPin?[selected.hookPin.program,pda(LOADER,pk(selected.hookPin.program).toBuffer())]:[]
 const observed=await readBoth(connections,[...programData,...Object.values(accountRoles),...selectedAddresses,...(launchTable?[launchTable]:[]),lookupTable])
 if(selected?.hookPin){
  const [program,data]=observed.slice(programRoles.length+Object.keys(accountRoles).length),pin=selected.hookPin
  need(program.owner===LOADER&&program.executable&&program.data.length===36&&program.data.readUInt32LE()===2
   &&pk(program.data.subarray(4)).toBase58()===selectedAddresses[1],'selected hook program link differs')
  need(data.owner===LOADER&&!data.executable&&data.data.length===45+pin.elfLength&&data.data.readUInt32LE()===3
   &&data.data[12]===0&&sha(data.data.subarray(45))===pin.elfSha256,'selected hook is not the exact immutable release executable')
 }
 const slot=Math.min(...await Promise.all(connections.map(c=>c.connection.getSlot('finalized'))))
 const programs=programRoles.map((role,i)=>{
  const bytes=observed[i].data,length=role==='token'?tokenElfLengthOf(base):elfLengths[role],expected=role==='token'?base.dependencyObservation.tokenElfSha256:base.elfSha256[role]
  need(observed[i].owner===LOADER&&bytes.readUInt32LE(0)===3&&bytes.length>=45+length,`${role} program data is not an upgradeable-loader program`)
  need(sha(bytes.subarray(45,45+length))===expected&&!bytes.subarray(45+length).some(b=>b!==0),`${role} deployed code differs from its reviewed pin`)
  const upgradeAuthority=bytes[12]?pk(bytes.subarray(13,45)).toBase58():null
  if(role==='gate')need(upgradeAuthority===null,'the gate is still upgradeable; finalize it first (separate irreversible approval)')
  // Our own stack: every other program is upgradeable only by the stack's upgrade authority (or no longer upgradeable).
  else if(base.stack)need(upgradeAuthority===null||upgradeAuthority===base.stack.upgradeAuthority,`${role} upgrade authority is not the stack's`)
  return {role,address:P[role],programData:programData[i],upgradeAuthority,deploySlot:Number(bytes.readBigUInt64LE(4)),programDataSha256:sha(bytes),elfLength:length,elfSha256:expected}
 })
 const accounts=Object.entries(accountRoles).map(([role,address],i)=>{
  const a=observed[programRoles.length+i]
  return {role,address,owner:a.owner,executable:a.executable,dataSha256:sha(a.data),...(['launch-config','swap-config'].includes(role)
   ?{binding:'config-counters-v1',approvedDataBase64:a.data.toString('base64'),idlSha256:sha(idls[role.split('-')[0]])}
   :role==='quote-mint'?quoteMintSupplyBinding(a.data):{})}
 })
 const table=observed.at(-1),launch=launchTable?observed.at(-2):null
 if(launch){
  // The shared launch table: frozen, active, exactly the constant addresses of an open launch under this profile and Config.
  need(launch.owner==='AddressLookupTab1e1111111111111111111111111','launch table is not an address lookup table')
  const state=AddressLookupTableAccount.deserialize(Uint8Array.from(launch.data)),envelope={json:reviewedJson,idls:profile.idls,elfLengths}
  need(!state.authority&&state.deactivationSlot===0xffffffffffffffffn,'launch table is not frozen and active; run the launch-table stage to completion')
  need(isDeepStrictEqual(state.addresses.map(a=>a.toBase58()),openLaunchTableAddresses(envelope,observed[programRoles.length].data)),'launch table addresses differ from the shared open-launch addresses')
 }
 need(table.owner==='AddressLookupTab1e1111111111111111111111111','lookup table is not an address lookup table')
 const tableState=AddressLookupTableAccount.deserialize(Uint8Array.from(table.data))
 // The shared trade table must be frozen with exactly the addresses every trade shares, so the pin never drifts.
 need(!tableState.authority&&tableState.deactivationSlot===0xffffffffffffffffn,'trade lookup table is not frozen and active; run the trade-table stage to completion')
 need(isDeepStrictEqual(tableState.addresses.map(a=>a.toBase58()),sharedTradeAddresses(JSON.parse(reviewedJson))),'trade lookup table addresses differ from the shared trade addresses')
 const lc=new BorshCoder(JSON.parse(idls.launch)).accounts.decode('Config',Buffer.from(accounts[0].approvedDataBase64,'base64'))
 const sc=new BorshCoder(JSON.parse(idls.swap)).accounts.decode('Config',Buffer.from(accounts[1].approvedDataBase64,'base64'))
 need(lc.max_creator_fee_bps>=CREATOR_FEE_CEILING_BPS&&lc.rule_bounds.max_rules_fee_bps>=CREATOR_FEE_CEILING_BPS,`launch fee ceilings are below ${CREATOR_FEE_CEILING_BPS} bps; apply the approved config change first`)
 need(lc.lp_fee_bps===0&&lc.sniper_start_bps===0&&lc.sniper_window_secs.isZero(),'launch LP or sniper fee is not zero')
 need(sc.launch_protocol_share_bps===2500&&sc.protocol_fee_bps===0,'swap config does not select the inclusive 25% split with zero protocol fee')
 need(sc.fee_collector.toBase58()===treasury&&sc.treasury.toBase58()===treasury&&lc.treasury.toBase58()===treasury,'fee collector or treasury is not the approved treasury')
 need(lc.admin.toBase58()===reviewer&&sc.admin.toBase58()===reviewer,'config admin is not the approved reviewer')
 const dossierJson=JSON.stringify({...(local?{schema:LOCAL_DOSSIER_SCHEMA,topology:'single-local-validator-two-proxies'}:{schema:'repoing/production-observation/2'}),genesisHash,
  artifacts:{sourceCommit:base.sourceCommit,profileSha256:profile.expectedSha256,sdkSha256,
   idlSha256:sha(Buffer.concat([idls.launch,idls.swap,idls.gate])),provenanceSha256:sha(JSON.stringify({sourceCommit:base.sourceCommit,sourcePatchSha256:base.sourcePatchSha256}))},
  providers:profile.providers,minSlot:slot,maxSlotLag:5,maxAgeMs:60000,programs,accounts})
 const config={schema:'repoing/inclusive-max-wallet-operator-config/1',feeModel:2,enabled:true,approvalReference,
  profileSha256:profile.expectedSha256,dossierSha256:sha(dossierJson),providerTrustDomains:trustDomains.map(({provider,trustDomain,origin})=>({provider,trustDomain,origin:`${new URL(origin).origin}/`})),
  economics:{creatorFeeBps:DEFAULT_CREATOR_FEE_BPS,authorShareBps:0,lpFeeBps:lc.lp_fee_bps,maxCreatorFeeBps:lc.max_creator_fee_bps,protocolFeeBps:sc.protocol_fee_bps,
   launchProtocolShareBps:sc.launch_protocol_share_bps,launchFeeLamports:lc.launch_fee_lamports.toString(),poolCreationFeeLamports:sc.pool_creation_fee_lamports.toString()},
  reviewer,treasury,lookupTable:{address:lookupTable,sha256:sha(table.data)},...(launch?{launchLookupTable:{address:launchTable,sha256:sha(launch.data)}}:{}),lamportsPerSignature:'5000'}
 if(selected){
  if(selected.hookPin)config.selectedHookPin=selected.hookPin
  config.selectedHookRelease={schema:selected.compatibilityPolicy?'repoing/selected-hook-release/2':'repoing/selected-hook-release/1',approvalReference,sourceCommit:base.sourceCommit,
   profileSha256:config.profileSha256,dossierSha256:config.dossierSha256,...selected}
  validateSelectedHookReleaseBindings({config,profile,dossierJson,connections})
 }
 return {schema:local?'repoing/local-operator-bundle/1':'repoing/production-operator-bundle/1',genesisHash,observedSlot:slot,profile,config,dossierJson}
}
