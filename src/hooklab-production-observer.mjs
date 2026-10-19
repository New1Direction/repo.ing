// Inert, source-independent evidence boundary. No active profile, RPC, SDK defaults or execution.
import {readFileSync} from 'node:fs'
import {BorshCoder} from '@anchor-lang/core'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { LOCAL_DOSSIER_SCHEMA, localAcceptanceNetwork, isLocalExecutionDossier } from './hooklab-local-acceptance.mjs'
import { NATIVE_BUILDS, loadNativeArtifacts, loadOpenArtifacts, nativeBuildForRole } from './hooklab-native-pins.mjs'
import { parseLaunchConfigReserved } from './hooklab-launch-config-reserved.mjs'
import { isNativeElfPin } from './hooklab-native-launch.mjs'

const sha = data => createHash('sha256').update(data).digest('hex')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const key = z.string().max(44).refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const mainnetGenesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const role = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const accountPin = z.object({ role, address: key, owner: key, executable: z.boolean(), dataSha256: hash }).strict()
const dossierV1 = z.object({
  schema: z.literal('repoing/production-observation/1'), genesisHash: z.literal(mainnetGenesis),
  artifacts: z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), profileSha256: hash,
    sdkSha256: hash, idlSha256: hash, provenanceSha256: hash }).strict(),
  // Distinct trust domains must be selected/reviewed by operators, not inferred from URL spelling.
  providers: z.array(role).length(2), minSlot: integer, maxSlotLag: integer.max(150),
  maxAgeMs: integer.positive().max(60000),
  programs: z.array(z.object({ role, address: key, programData: key, upgradeAuthority: key.nullable(),
    deploySlot: integer, programDataSha256: hash, elfLength: integer.positive().max(10485760), elfSha256: hash,
  }).strict()).min(3).max(20),
  accounts: z.array(accountPin).min(4).max(80),
}).strict()
const stableAccountPin=accountPin.extend({binding:z.literal('config-counters-v1'),approvedDataBase64:z.string().max(8192),idlSha256:hash}).strict()
// The bridged-SOL quote mint: only `supply` may move (every wrap and unwrap through the public bridge changes it).
const mintSupplyAccountPin=accountPin.extend({binding:z.literal('mint-supply-v1'),approvedDataBase64:z.string().max(8192),idlSha256:hash}).strict()
export const productionDossierSchema=z.union([dossierV1,dossierV1.extend({schema:z.literal('repoing/production-observation/2'),accounts:z.array(z.union([accountPin,stableAccountPin,mintSupplyAccountPin])).min(4).max(80)}).strict()])
export function parseExecutionDossier(value) {
  if (value?.schema !== LOCAL_DOSSIER_SCHEMA) return productionDossierSchema.parse(value)
  const local = localAcceptanceNetwork()
  if (!local) throw Error('Local dossier requires isolated acceptance configuration')
  return dossierV1.extend({ schema: z.literal(LOCAL_DOSSIER_SCHEMA), genesisHash: z.literal(local.genesisHash),
    topology: z.literal('single-local-validator-two-proxies'),
    accounts: z.array(z.union([accountPin, stableAccountPin, mintSupplyAccountPin])).min(4).max(80) }).strict().parse(value)
}
// Runtime source artifacts are rooted at the app directory and included in Next tracing.
const codecBytes={launch:readFileSync(`${process.cwd()}/vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_launch.json`),swap:readFileSync(`${process.cwd()}/vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_swap.json`)}
const codecs=Object.fromEntries(['launch','swap'].map(role=>{const bytes=codecBytes[role];return [role,{sha256:sha(bytes),coder:new BorshCoder(JSON.parse(bytes)),idl:JSON.parse(bytes)}]}))
// Config codec for a config-counters-v1 pin. Reviewed builds: bundle 2 (the IDLs above) and the native-SOL builds
// (e357fdf, and the open-creation build: vendor/hooklab-native-candidate, loaded on first use and only with their
// reviewed bytes). Config has the same layout in all; the pin names its build by IDL hash, and that must be the build its
// program's ELF pin names: a native IDL only beside that native build's ELF, the bundle-2 IDL never beside a native ELF.
// Any other IDL hash is refused.
// idls: the envelope's own IDLs (base64), for a stack bundle whose IDLs are its own; matched by the pin's IDL hash.
function configCodec(role,pin,program,idls){
 const own=idls?.[role]&&Buffer.from(idls[role],'base64')
 if(own&&sha(own)===pin.idlSha256){const idl=JSON.parse(own);return {sha256:pin.idlSha256,coder:new BorshCoder(idl),idl}}
 const build=nativeBuildForRole(role,{elfSha256:program.elfSha256,elfLength:program.elfLength,idlSha256:pin.idlSha256})
 if(!build){
  if(isNativeElfPin(role,program.elfSha256,program.elfLength))return null
  return codecs[role].sha256===pin.idlSha256?codecs[role]:null
 }
 const reviewed=build==='open-36dd07e'?loadOpenArtifacts():loadNativeArtifacts()
 return {sha256:NATIVE_BUILDS[build].idlSha256[role],coder:reviewed.coders[role],idl:reviewed.idls[role]}
}
const tokenIdlBytes=readFileSync(`${process.cwd()}/vendor/hooklab-production-candidate/idl/bordrless_token.json`)
export const TOKEN_IDL_SHA256=sha(tokenIdlBytes)
const tokenCodec={sha256:TOKEN_IDL_SHA256,coder:new BorshCoder(JSON.parse(tokenIdlBytes)),discriminator:Buffer.from(JSON.parse(tokenIdlBytes).accounts.find(a=>a.name==='Mint').discriminator)}
// A canonical Mint: its discriminator, then exactly the IDL encoding, then only zero padding to the allocation.
function decodeMint(bytes){
 if(!bytes.subarray(0,8).equals(tokenCodec.discriminator))throw Error('Not a Mint account')
 const value=tokenCodec.coder.accounts.decode('Mint',bytes),encoded=Buffer.concat([tokenCodec.discriminator,tokenCodec.coder.types.encode('Mint',value)])
 if(!bytes.subarray(0,encoded.length).equals(encoded)||bytes.subarray(encoded.length).some(b=>b!==0))throw Error('Noncanonical Mint')
 return value
}
// Pin the reviewed quote-mint bytes so only `supply` may change afterwards (see mintSupplyBindingMatches).
export const quoteMintSupplyBinding=data=>({binding:'mint-supply-v1',approvedDataBase64:Buffer.from(data).toString('base64'),idlSha256:TOKEN_IDL_SHA256})
// mint-supply-v1: the live quote mint, with its supply set back to the reviewed snapshot's, must be byte-identical to that
// snapshot (same allocation). Authorities, hook program and flags, decimals, identity and padding cannot change.
function mintSupplyBindingMatches(pin,current,dossier){
 if(pin.role!=='quote-mint'||pin.executable||(dossier.schema!=='repoing/production-observation/2'&&!isLocalExecutionDossier(dossier)))return false
 const token=dossier.programs.find(p=>p.role==='token')
 if(!token||pin.owner!==token.address||pin.idlSha256!==tokenCodec.sha256)return false
 const approved=rawAccount({dataBase64:pin.approvedDataBase64})
 if(sha(approved)!==pin.dataSha256||approved.length!==current.length)return false
 const base=decodeMint(approved),live=decodeMint(current)
 live.supply=base.supply
 const relaid=Buffer.concat([tokenCodec.discriminator,tokenCodec.coder.types.encode('Mint',live)])
 return Buffer.concat([relaid,Buffer.alloc(approved.length-relaid.length)]).equals(approved)
}
export function productionAccountBindingMatches(pin,observed,dossier,idls=null){
 try{
  if(!observed||observed.address!==pin.address||observed.owner!==pin.owner||observed.executable!==pin.executable)return false
  const current=rawAccount(observed)
  if(!pin.binding)return sha(current)===pin.dataSha256
  if(pin.binding==='mint-supply-v1')return mintSupplyBindingMatches(pin,current,dossier)
  if(pin.binding!=='config-counters-v1'||(dossier.schema!=='repoing/production-observation/2'&&!isLocalExecutionDossier(dossier))||pin.executable||!['launch-config','swap-config'].includes(pin.role))return false
  const role=pin.role.split('-')[0],program=dossier.programs.find(p=>p.role===role),codec=program&&configCodec(role,pin,program,idls)
  if(!codec||pin.address!==PublicKey.findProgramAddressSync([Buffer.from('config')],new PublicKey(program.address))[0].toBase58()||program.address!==pin.owner||codec.sha256!==pin.idlSha256||codec.idl.address!==program.address)return false
  const approved=rawAccount({dataBase64:pin.approvedDataBase64});if(sha(approved)!==pin.dataSha256||approved.length!==current.length)return false
  const decode=bytes=>{const value=codec.coder.accounts.decode('Config',bytes),encoded=Buffer.concat([bytes.subarray(0,8),codec.coder.types.encode('Config',value)]);if(!encoded.equals(bytes))throw Error('Noncanonical Config');return value}
  const base=decode(approved),live=decode(current),field=role==='launch'?'launches':'pools_created'
  if(live[field].lt(base[field]))return false
  live[field]=base[field]
  // The launch Config's governed switches (native launches, open creation) and creator menus live in its reserved bytes
  // and may move between any states the reviewed programs write; every compiler reads them live. Nothing else may.
  if(role==='launch'){
   if(!parseLaunchConfigReserved(Buffer.from(live.reserved))||!parseLaunchConfigReserved(Buffer.from(base.reserved)))return false
   live.reserved=base.reserved
  }
  return Buffer.concat([current.subarray(0,8),codec.coder.types.encode('Config',live)]).equals(approved)
 }catch{return false}
}
const observationSchema = z.object({ provider: role, genesisHash: key, commitment: z.literal('finalized'),
  slot: integer, observedAtMs: integer,
  accounts: z.array(z.object({ address: key, owner: key, executable: z.boolean(),
    dataBase64: z.string().max(14000000),
  }).strict()).max(120),
}).strict()
class EvidenceMismatch extends Error {}
const check = (ok, message) => { if (!ok) throw new EvidenceMismatch(message) }
function rawAccount(account) {
  const raw = Buffer.from(account.dataBase64, 'base64')
  check(raw.toString('base64') === account.dataBase64, 'Noncanonical account bytes')
  return raw
}

export function productionReadiness() {
  return { schema: 'repoing/production-readiness/1', status: 'unavailable', network: 'mainnet-beta',
    activeProfile: null, observedSlot: null, deploymentVerified: false, policyVerified: false,
    actions: { observe: false, recover: false, create: false, quote: false, simulate: false,
      review: false, sign: false, submit: false, buy: false, sell: false, addLiquidity: false,
      removeLiquidity: false, claimFees: false, index: false },
    blockers: ['No adopted frozen source/profile/SDK/IDL/provenance package.',
      'No finalized two-provider production account bindings or operation receipts.',
      'No approved creator, operation contracts, budgets or activation.'],
  }
}

/** Offline verification of a retained operator dossier, NOT public JSON supplied as authority.
 * expectedSha256 must be independently reviewed; matching a caller's own hash proves nothing.
 * Exact bytes bind dependencies and configuration, but do not decode/approve their semantics.
 * No result enables execution, asserts custody, or marks a token operation settled.
 */
export function inspectProductionEvidence({ dossierJson, expectedSha256, observations, nowMs, idls = null } = {}) {
  const out = { status: 'unavailable', reason: 'Reviewed dossier and two independent observations required',
    observedSlots: [], accountBindingsMatched: false, policyVerified: false, provenanceVerified: false,
    canSign: false, canSubmit: false, canRetry: false }
  if (dossierJson == null || observations == null) return out
  try {
    check(typeof dossierJson === 'string' && Buffer.byteLength(dossierJson) <= 65536, 'Invalid dossier size')
    check(hash.parse(expectedSha256) === sha(dossierJson), 'Dossier digest mismatch')
    const d = parseExecutionDossier(JSON.parse(dossierJson))
    const now = integer.parse(nowMs)
    check(new Set(d.providers).size === 2, 'Independent provider bindings required')
    check(['launch', 'swap', 'token'].every(r => d.programs.some(p => p.role === r)), 'Missing executable dependency')
    check(['launch-config', 'swap-config', 'quote-mint', 'creation-control'].every(r => d.accounts.some(a => a.role === r)), 'Missing config/control/quote binding')
    const roles = [...d.programs, ...d.accounts].map(a => a.role)
    check(new Set(roles).size === roles.length, 'Duplicate evidence role')
    const addresses = [...d.programs.flatMap(p => [p.address, p.programData]), ...d.accounts.map(a => a.address)]
    check(new Set(addresses).size === addresses.length, 'Duplicate evidence address')
    check(Array.isArray(observations) && observations.length === 2, 'Two observations required')
    const obs = observations.map(o => observationSchema.parse(o))
    check(new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => d.providers.includes(o.provider)), 'Provider binding differs')
    check(Math.abs(obs[0].slot - obs[1].slot) <= d.maxSlotLag, 'Provider slots diverge')
    for (const o of obs) {
      check(o.genesisHash === d.genesisHash && o.slot >= d.minSlot, 'Network or minimum slot differs')
      check(now >= o.observedAtMs && now - o.observedAtMs <= d.maxAgeMs, 'Observation stale or in future')
      const accounts = new Map(o.accounts.map(a => [a.address, a]))
      check(accounts.size === addresses.length && o.accounts.length === addresses.length
        && addresses.every(a => accounts.has(a)), 'Incomplete or duplicate account inventory')
      for (const p of d.programs) {
        const program = accounts.get(p.address), pd = accounts.get(p.programData)
        const programBytes = rawAccount(program), data = rawAccount(pd)
        const derived = PublicKey.findProgramAddressSync([new PublicKey(p.address).toBuffer()], new PublicKey(loader))[0].toBase58()
        check(p.programData === derived && program.owner === loader && program.executable && programBytes.length === 36
          && programBytes.readUInt32LE(0) === 2 && new PublicKey(programBytes.subarray(4)).toBase58() === p.programData, 'Program/loader/ProgramData linkage differs')
        check(pd.owner === loader && !pd.executable && data.length >= 45 + p.elfLength && data.readUInt32LE(0) === 3, 'Invalid ProgramData')
        check(data.readBigUInt64LE(4) === BigInt(p.deploySlot) && p.deploySlot <= o.slot, 'Deployment slot differs')
        check(data[12] === (p.upgradeAuthority === null ? 0 : 1), 'Authority option differs')
        if (p.upgradeAuthority !== null) check(new PublicKey(data.subarray(13, 45)).toBase58() === p.upgradeAuthority, 'Upgrade authority differs')
        const elf = data.subarray(45, 45 + p.elfLength)
        check(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha(elf) === p.elfSha256
          && data.subarray(45 + p.elfLength).every(b => b === 0), 'ELF bytes or trailing allocation differ')
        check(sha(data) === p.programDataSha256, 'ProgramData bytes/allocation drift')
      }
      for (const a of d.accounts) {
        const observed = accounts.get(a.address)
        check(productionAccountBindingMatches(a,observed,d,idls), 'Config/control/quote account drift')
      }
    }
    return { ...out, status: 'account-bindings-matched', reason: 'Retained bytes match; policy semantics, provenance signatures and operation receipts remain unverified',
      observedSlots: obs.map(o => o.slot), accountBindingsMatched: true }
  } catch (error) {
    // Never return arbitrary RPC errors, provider URLs, account data or caller text.
    return { ...out, status: 'mismatch', reason: error instanceof EvidenceMismatch
      ? error.message : 'Invalid production evidence shape or bytes; do not infer readiness' }
  }
}
