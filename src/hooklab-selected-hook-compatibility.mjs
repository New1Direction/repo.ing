// Server-only authority evidence. This is NOT an ABI audit or execution authorization.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress, hookDigest } from './hooklab-execution-contract.mjs'
import { localAcceptanceNetwork, LOCAL_DOSSIER_SCHEMA } from './hooklab-local-acceptance.mjs'
const loader='BPFLoaderUpgradeab1e11111111111111111111111'
const timelock='BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ'
export const SELECTED_HOOK_REFERENCE_COMMIT='7fde54001d7f0c88b17c87babf73fb40be07b3cb'
export const selectedHookCompatibilityPolicySchema=z.object({
 schema:z.literal('repoing/selected-hook-compatibility/2'),referenceCommit:z.literal(SELECTED_HOOK_REFERENCE_COMMIT),
 abi:z.object({family:z.literal('bordrless-token-hook-v1'),tokenFlagsMask:z.literal(255),registryVersion:z.literal(1),
  registryDiscriminator:z.literal('02daf6662c38c0cd'),maxRegistryExtras:z.literal(32),allowExtraSigners:z.literal(false)}).strict(),
 authority:z.object({immutable:z.literal(true),
  timelock:z.object({program:z.literal(timelock),minDelaySeconds:z.literal(259200),requireIdle:z.literal(true)}).strict(),
  trustedUpgradeAuthorities:z.array(hookAddress).length(0)}).strict(),
}).strict()
export const selectedHookPolicyReleaseSchema=z.object({
 schema:z.literal('repoing/selected-hook-release/2'),approvalReference:z.string().min(1).max(256),
 sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),profileSha256:hookDigest,dossierSha256:hookDigest,
 compatibilityPolicy:selectedHookCompatibilityPolicySchema,acceptanceSha256:hookDigest,releaseVerificationSha256:hookDigest,
}).strict()
const evidenceAccount=z.object({address:hookAddress,owner:hookAddress,executable:z.boolean(),dataBase64:z.string().max(14000000)}).strict()
export const selectedHookAuthorityEvidenceSchema=z.object({
 schema:z.literal('repoing/selected-hook-authority-evidence/2'),genesisHash:hookAddress,policySha256:hookDigest,
 hookPin:z.object({program:hookAddress,elfSha256:hookDigest,elfLength:z.number().int().min(4).max(10485760)}).strict(),
 programAccount:evidenceAccount,programData:evidenceAccount,
 authority:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('immutable'),upgradeAuthority:z.null()}).strict(),
  z.object({kind:z.literal('timelocked'),upgradeAuthority:hookAddress,delaySeconds:z.number().int().min(259200),timelock:evidenceAccount,
   executor:evidenceAccount,executorProgramData:evidenceAccount}).strict(),
 ]),programSha256:hookDigest,programDataSha256:hookDigest,executableSha256:hookDigest,
 observedSlot:z.number().int().nonnegative(),providers:z.array(z.string()).length(2),
 topology:z.literal('single-local-validator-two-proxies').optional(),
}).strict()
const check=(v,m)=>{if(!v)throw Object.assign(Error(m),{code:'SELECTED_HOOK_COMPATIBILITY_UNAVAILABLE'})}
const pk=v=>new PublicKey(hookAddress.parse(v))
const sha=v=>createHash('sha256').update(v).digest('hex')
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
// Local-only release boundary, also usable by the release collector after its ordinary
// operator binding validation. Never relabel a local dossier as production evidence.
export function validateLocalSelectedHookPolicy({config:c,profile,dossierJson,connections,env=process.env}){
 const local=localAcceptanceNetwork(env),d=JSON.parse(dossierJson),p=JSON.parse(profile.json)
 check(local&&d.schema===LOCAL_DOSSIER_SCHEMA&&d.topology===local.topology&&d.genesisHash===local.genesisHash&&p.genesisHash===local.genesisHash,'Explicit local dossier required')
 const r=selectedHookPolicyReleaseSchema.parse(c.selectedHookRelease)
 check(c.selectedHookPin===undefined&&p.stack?.open===true&&!p.programs.bridge&&c.feeModel===2&&c.launchLookupTable,'Local policy requires the open stack without singleton')
 check(r.approvalReference===c.approvalReference&&r.sourceCommit===p.sourceCommit&&r.profileSha256===c.profileSha256&&r.dossierSha256===c.dossierSha256
  &&sha(profile.json)===c.profileSha256&&profile.expectedSha256===c.profileSha256&&sha(dossierJson)===c.dossierSha256
  &&d.artifacts.profileSha256===c.profileSha256&&d.artifacts.sourceCommit===p.sourceCommit,'Local policy binding differs')
 check(connections?.length===2&&connections[0].connection!==connections[1].connection,'Two labelled local readers required')
 check(equal(connections.map(c=>c.provider),profile.providers)&&equal(profile.providers,d.providers)
  &&equal(profile.providers,c.providerTrustDomains.map(c=>c.provider))&&new Set(profile.providers).size===2,'Local reader labels differ')
 check(connections.every((reader,i)=>new URL(reader.connection.rpcEndpoint).href===`${local.endpoints[i]}/`
  &&new URL(c.providerTrustDomains[i].origin).href===`${local.endpoints[i]}/`),'Local reader endpoints differ')
 check(c.providerTrustDomains.every(p=>p.trustDomain==='single-local-validator'),'Local topology must not claim independent trust domains')
 check(['launch-config','swap-config'].every(role=>d.accounts.some(a=>a.role===role&&a.binding==='config-counters-v1')),'Local policy requires stable config bindings')
 return r
}
/** All arguments except program come from server configuration/durable operation state.
 * expectedEvidence MUST be the original durable evidence on every subsequent stage.
 * Returned hookPin hashes the full allocated ELF, matching the existing compiler; executableSha256
 * additionally records upstream's trailing-zero-stripped hash. Neither is browser approval.
 * Timelocked evidence requires the parent's authority-aware selectedHookAccountPlan before use.
 */
export async function observeSelectedHookCompatibility(input){
 check(!Object.hasOwn(input,'hookPin')&&!Object.hasOwn(input,'upgradeAuthority')&&!Object.hasOwn(input,'elfSha256'),'Client executable assertions forbidden')
 const {program,connections,genesisHash,forbiddenPrograms,minContextSlot=0,expectedEvidence}=input
 const policy=selectedHookCompatibilityPolicySchema.parse(input.policy),key=pk(program)
 check(Array.isArray(forbiddenPrograms)&&forbiddenPrograms.length>0,'Server role exclusions required')
 check(!['11111111111111111111111111111111',loader,timelock,'BPFLoader2111111111111111111111111111111','LoaderV411111111111111111111111111111111111',...forbiddenPrograms].includes(program),'Forbidden hook role')
 check(Number.isSafeInteger(minContextSlot)&&minContextSlot>=0,'Invalid minimum slot')
 check(connections?.length===2&&connections[0].connection!==connections[1].connection,'Two independent readers required')
 const local=localAcceptanceNetwork()
 for(const field of local?['provider']:['provider','trustDomain'])check(connections.every(c=>typeof c[field]==='string'&&c[field].length>0)&&new Set(connections.map(c=>c[field])).size===2,'Independent reader identities required')
 if(local)check(genesisHash===local.genesisHash&&connections.every((c,i)=>c.trustDomain==='single-local-validator'
  &&new URL(c.connection.rpcEndpoint).href===`${local.endpoints[i]}/`),'Local topology or network differs')
 const origins=connections.map(c=>{const u=new URL(c.connection.rpcEndpoint);check(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'Invalid reader origin');return u.origin})
 check(new Set(origins).size===2,'Independent origins required')
 const pd=PublicKey.findProgramAddressSync([key.toBuffer()],pk(loader))[0], [tl,bump]=PublicKey.findProgramAddressSync([Buffer.from('timelock'),key.toBuffer()],pk(timelock))
 const executorData=PublicKey.findProgramAddressSync([pk(timelock).toBuffer()],pk(loader))[0]
 const keys=[key,pd,tl,pk(timelock),executorData],slots=[]
 const rows=await Promise.all(connections.map(async({connection:c})=>{
  check(await c.getGenesisHash()===genesisHash,'Wrong network')
  const r=await c.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:Math.max(minContextSlot,expectedEvidence?.observedSlot??0)})
  check(Number.isSafeInteger(r.context.slot)&&r.context.slot>=Math.max(minContextSlot,expectedEvidence?.observedSlot??0)&&r.value.length===keys.length,'Stale or incomplete read');slots.push(r.context.slot)
  return r.value.map((a,i)=>a?{address:keys[i].toBase58(),owner:a.owner.toBase58(),executable:a.executable,dataBase64:Buffer.from(a.data).toString('base64')}:null)
 }))
 check(equal(rows[0],rows[1]),'Provider disagreement')
 const [p,d,t,executor,executorProgramData]=rows[0],pb=Buffer.from(p?.dataBase64??'','base64'),db=Buffer.from(d?.dataBase64??'','base64')
 check(p?.owner===loader&&p.executable===true&&pb.length===36&&pb.readUInt32LE()===2&&pb.subarray(4).equals(pd.toBuffer()),'Program linkage differs')
 check(d?.owner===loader&&d.executable===false&&db.length>=49&&db.length<=10485805&&db.readUInt32LE()===3&&db.subarray(45,49).equals(Buffer.from([127,69,76,70])),'Invalid ProgramData')
 check(db.readBigUInt64LE(4)<=BigInt(Math.min(...slots)),'Future deployment slot')
 let authority
 if(db[12]===0)authority={kind:'immutable',upgradeAuthority:null}
 else{
  check(db[12]===1&&db.subarray(13,45).equals(tl.toBuffer()),'Unbounded upgrade authority')
  const b=Buffer.from(t?.dataBase64??'','base64')
  check(t?.owner===timelock&&t.executable===false&&b.length===279&&b.subarray(0,8).equals(Buffer.from('bd214e4bcd1f04b1','hex'))
   &&b[8]===1&&b[9]===bump&&b.subarray(10,42).equals(key.toBuffer())&&b.subarray(42,74).equals(pd.toBuffer())
   &&b.readUInt32LE(138)>=259200&&b[142]===0&&b.subarray(143,227).every(v=>v===0),'Invalid, short or pending timelock')
  const eb=Buffer.from(executor?.dataBase64??'','base64'),edb=Buffer.from(executorProgramData?.dataBase64??'','base64')
  check(executor?.owner===loader&&executor.executable===true&&eb.length===36&&eb.readUInt32LE()===2&&eb.subarray(4).equals(executorData.toBuffer())
   &&executorProgramData?.owner===loader&&executorProgramData.executable===false&&edb.length>=49&&edb.readUInt32LE()===3&&edb[12]===0
   &&edb.readBigUInt64LE(4)<=BigInt(Math.min(...slots))&&edb.subarray(45,49).equals(Buffer.from([127,69,76,70])),'Timelock executor must be immutable')
  authority={kind:'timelocked',upgradeAuthority:tl.toBase58(),delaySeconds:b.readUInt32LE(138),timelock:t,executor,executorProgramData}
 }
 const elf=db.subarray(45);let end=elf.length;while(end&&elf[end-1]===0)end--
 const identity={schema:'repoing/selected-hook-authority-evidence/2',...(local?{topology:local.topology}:{}),genesisHash,policySha256:sha(JSON.stringify(policy)),
  hookPin:{program,elfSha256:sha(elf),elfLength:elf.length},programAccount:p,programData:d,authority,
  programSha256:sha(pb),programDataSha256:sha(db),executableSha256:sha(elf.subarray(0,end))}
 if(expectedEvidence){const {observedSlot,providers,...retained}=expectedEvidence;check(equal(identity,retained),'Retained executable or authority changed')}
 return freeze({...identity,observedSlot:Math.max(...slots),providers:connections.map(c=>c.provider)})
}
