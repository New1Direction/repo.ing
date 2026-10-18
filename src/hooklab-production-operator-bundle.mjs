// Read-only production operator bundle: the reviewed profile (with the owner's fee and cap menus),
// the production observation dossier, and the operator configuration the server validates at start.
// Two independent mainnet providers must return identical bytes for every account. It refuses unless
// the gate is immutable, every deployed program equals its reviewed pin, and both configs already
// carry the approved economics. It never signs, sends or reads secrets.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { CREATOR_FEE_BPS_CHOICES,DEFAULT_CREATOR_FEE_BPS,WALLET_CAP_BPS_CHOICES,DEFAULT_WALLET_CAP_BPS,CREATOR_FEE_CEILING_BPS } from './hooklab-launch-menus.mjs'
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111',TOKEN_ELF_LENGTH=326504
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
 return {base,idls,elfLengths:{launch:build.artifacts.launch.elfLength,swap:build.artifacts.swap.elfLength,gate:build.artifacts.gate.elfLength}}
}
// The reviewed profile plus the owner-approved creator menus. Changing a menu changes this hash.
export function productionProfileJson(base){
 return JSON.stringify({...base,profileId:`production-menus-${base.profileId}`.slice(0,64),
  capability:{...base.capability,creatorFeeBps:DEFAULT_CREATOR_FEE_BPS,creatorFeeBpsChoices:[...CREATOR_FEE_BPS_CHOICES],
   capBpsChoices:[...WALLET_CAP_BPS_CHOICES],defaultCapBps:DEFAULT_WALLET_CAP_BPS}})
}

async function readBoth(connections,addresses){
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
export async function collectProductionOperatorBundle({connections,trustDomains,lookupTable,reviewer,treasury,approvalReference,artifacts=productionArtifacts()}){
 need(Array.isArray(connections)&&connections.length===2&&new Set(connections.map(c=>c.provider)).size===2,'two distinct providers required')
 need(isDeepStrictEqual(connections.map(c=>c.provider),trustDomains.map(t=>t.provider))&&new Set(trustDomains.map(t=>t.trustDomain)).size===2,'two independent reviewed trust domains required')
 for(const [i,{connection}] of connections.entries())need(new URL(connection.rpcEndpoint).origin===new URL(trustDomains[i].origin).origin,'provider origin differs from its reviewed trust domain')
 need((await Promise.all(connections.map(c=>c.connection.getGenesisHash()))).every(g=>g===MAINNET_GENESIS),'a provider is not mainnet')
 const {base,idls,elfLengths}=artifacts,profileJson=productionProfileJson(base),P=base.programs
 const profile={json:profileJson,expectedSha256:sha(profileJson),providers:connections.map(c=>c.provider),
  idls:Object.fromEntries(Object.entries(idls).map(([role,bytes])=>[role,bytes.toString('base64')])),elfLengths}
 const programRoles=['launch','swap','gate','token'],programData=programRoles.map(role=>pda(LOADER,pk(P[role]).toBuffer()))
 const accountRoles={'launch-config':pda(P.launch,'config'),'swap-config':pda(P.swap,'config'),'creation-control':pda(P.launch,'governance'),'swap-governance':pda(P.swap,'governance'),'quote-mint':base.quoteMint}
 const observed=await readBoth(connections,[...programData,...Object.values(accountRoles),lookupTable])
 const slot=Math.min(...await Promise.all(connections.map(c=>c.connection.getSlot('finalized'))))
 const programs=programRoles.map((role,i)=>{
  const bytes=observed[i].data,length=role==='token'?TOKEN_ELF_LENGTH:elfLengths[role],expected=role==='token'?base.dependencyObservation.tokenElfSha256:base.elfSha256[role]
  need(observed[i].owner===LOADER&&bytes.readUInt32LE(0)===3&&bytes.length>=45+length,`${role} program data is not an upgradeable-loader program`)
  need(sha(bytes.subarray(45,45+length))===expected&&!bytes.subarray(45+length).some(b=>b!==0),`${role} deployed code differs from its reviewed pin`)
  const upgradeAuthority=bytes[12]?pk(bytes.subarray(13,45)).toBase58():null
  if(role==='gate')need(upgradeAuthority===null,'the gate is still upgradeable; finalize it first (separate irreversible approval)')
  return {role,address:P[role],programData:programData[i],upgradeAuthority,deploySlot:Number(bytes.readBigUInt64LE(4)),programDataSha256:sha(bytes),elfLength:length,elfSha256:expected}
 })
 const accounts=Object.entries(accountRoles).map(([role,address],i)=>{
  const a=observed[programRoles.length+i]
  return {role,address,owner:a.owner,executable:a.executable,dataSha256:sha(a.data),...(['launch-config','swap-config'].includes(role)
   ?{binding:'config-counters-v1',approvedDataBase64:a.data.toString('base64'),idlSha256:sha(idls[role.split('-')[0]])}:{})}
 })
 const table=observed.at(-1)
 need(table.owner==='AddressLookupTab1e1111111111111111111111111','lookup table is not an address lookup table')
 const lc=new BorshCoder(JSON.parse(idls.launch)).accounts.decode('Config',Buffer.from(accounts[0].approvedDataBase64,'base64'))
 const sc=new BorshCoder(JSON.parse(idls.swap)).accounts.decode('Config',Buffer.from(accounts[1].approvedDataBase64,'base64'))
 need(lc.max_creator_fee_bps>=CREATOR_FEE_CEILING_BPS&&lc.rule_bounds.max_rules_fee_bps>=CREATOR_FEE_CEILING_BPS,`launch fee ceilings are below ${CREATOR_FEE_CEILING_BPS} bps; apply the approved config change first`)
 need(lc.lp_fee_bps===0&&lc.sniper_start_bps===0&&lc.sniper_window_secs.isZero(),'launch LP or sniper fee is not zero')
 need(sc.launch_protocol_share_bps===2500&&sc.protocol_fee_bps===0,'swap config does not select the inclusive 25% split with zero protocol fee')
 need(sc.fee_collector.toBase58()===treasury&&sc.treasury.toBase58()===treasury&&lc.treasury.toBase58()===treasury,'fee collector or treasury is not the approved treasury')
 need(lc.admin.toBase58()===reviewer&&sc.admin.toBase58()===reviewer,'config admin is not the approved reviewer')
 const dossierJson=JSON.stringify({schema:'repoing/production-observation/2',genesisHash:MAINNET_GENESIS,
  artifacts:{sourceCommit:base.sourceCommit,profileSha256:profile.expectedSha256,sdkSha256:sha(vendor('build-artifacts.json')),
   idlSha256:sha(Buffer.concat([idls.launch,idls.swap,idls.gate])),provenanceSha256:sha(JSON.stringify({sourceCommit:base.sourceCommit,sourcePatchSha256:base.sourcePatchSha256}))},
  providers:profile.providers,minSlot:slot,maxSlotLag:5,maxAgeMs:60000,programs,accounts})
 const config={schema:'repoing/inclusive-max-wallet-operator-config/1',feeModel:2,enabled:true,approvalReference,
  profileSha256:profile.expectedSha256,dossierSha256:sha(dossierJson),providerTrustDomains:trustDomains.map(({provider,trustDomain,origin})=>({provider,trustDomain,origin:`${new URL(origin).origin}/`})),
  economics:{creatorFeeBps:DEFAULT_CREATOR_FEE_BPS,authorShareBps:0,lpFeeBps:lc.lp_fee_bps,maxCreatorFeeBps:lc.max_creator_fee_bps,protocolFeeBps:sc.protocol_fee_bps,
   launchProtocolShareBps:sc.launch_protocol_share_bps,launchFeeLamports:lc.launch_fee_lamports.toString(),poolCreationFeeLamports:sc.pool_creation_fee_lamports.toString()},
  reviewer,treasury,lookupTable:{address:lookupTable,sha256:sha(table.data)},lamportsPerSignature:'5000'}
 return {schema:'repoing/production-operator-bundle/1',genesisHash:MAINNET_GENESIS,observedSlot:slot,profile,config,dossierJson}
}
