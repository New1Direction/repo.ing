// SERVER-ONLY candidate encrypted custody lifecycle. No key generation, signing,
// submission, public route or secret-returning operation. Explicit enablement only.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { parseMaxWalletPreparationRequest } from './hooklab-inclusive-max-wallet-profile.mjs'
import { selectedHookPreparationRequestSchema } from './hooklab-selected-hook-preparation.mjs'
import { Keypair } from '@solana/web3.js'
import { walletPrincipalStore } from './hooklab-wallet-principal.mjs'
import { lockWalletPrincipal } from './hooklab-wallet-principal-lock.mjs'
import { executionGenesis } from './hooklab-local-acceptance.mjs'
import { nativeSignerCustodyCodec,nativeCustodyIdentitySchema } from './hooklab-native-signer-custody.mjs'
const fail=()=>Object.assign(Error('Native signer custody unavailable or changed'),{code:'NATIVE_CUSTODY_UNAVAILABLE'})
const check=value=>{if(!value)throw fail()}
const edges={reserved:['preparation-reviewed'],'preparation-reviewed':['reserved','preparation-signed'],
 'preparation-signed':['preparation-finalized','reconcile-required'],'preparation-finalized':['launch-reviewed'],
 'launch-reviewed':['preparation-finalized','launch-signed'],'launch-signed':['launch-finalized','reconcile-required'],
 'launch-finalized':[],'reconcile-required':[]}
const identity=row=>nativeCustodyIdentitySchema.parse({schema:'repoing/native-signer-custody/1',operationId:row.operation_id,
 custodySessionId:row.custody_session_id,owner:row.owner_wallet,profileSha256:row.profile_sha256,mint:row.mint,selectedConfig:row.selected_config,stage:row.stage})
const summary=row=>Object.freeze({operationId:row.operation_id,custodySessionId:row.custody_session_id,owner:row.owner_wallet,
 profileSha256:row.profile_sha256,mint:row.mint,selectedConfig:row.selected_config,stage:row.stage,revision:String(row.revision),keyId:row.sealed_signers.keyId,
 preparedRequest:row.preparation_request??null,encryptedSignersRetained:true,ownerCustodyApprovalVerified:false,canSign:false,canSubmit:false,executionAuthorized:false})
const wipe=signers=>{signers?.mint?.secretKey?.fill(0);signers?.selectedConfig?.secretKey?.fill(0)}
const parseRequest=request=>request?.policyKind==='selected-hook'?selectedHookPreparationRequestSchema.parse(request):parseMaxWalletPreparationRequest(request)
export function nativeSignerCustodyStore(pool,{enabled=false,origin,keyRing,activeKeyId,signerFactory=()=>({mint:Keypair.generate(),selectedConfig:Keypair.generate()})}={}){
 const principal=walletPrincipalStore(pool,{enabled,origin,audience:'general-launcher',genesisHash:executionGenesis()})
 const codec=nativeSignerCustodyCodec({enabled,keyRing,activeKeyId})
 async function transaction(sessionToken,operationId,work){
  let db
  try{
   check(enabled===true);z.uuid().parse(operationId);check(operationId===operationId.toLowerCase())
   const owner=(await principal.resolve(sessionToken)).wallet;db=await pool.connect()
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`native-custody:${operationId}`])
   const {rows:[row]}=await db.query('select * from hook_lab_native_signer_custody where operation_id=$1 for update',[operationId])
   if(row)check(row.owner_wallet===owner)
   check((await lockWalletPrincipal(db,sessionToken,origin)).wallet===owner)
   const result=await work(db,row,owner)
   check((await lockWalletPrincipal(db,sessionToken,origin)).wallet===owner)
   await db.query('commit');return result
  }catch{try{await db?.query('rollback')}catch{}throw fail()}finally{db?.release()}
 }
 async function saveNew(db,operationId,profileSha256,owner,signers){
    const bound={schema:'repoing/native-signer-custody/1',operationId,custodySessionId:randomUUID(),owner,profileSha256,
     mint:signers.mint.publicKey.toBase58(),selectedConfig:signers.selectedConfig.publicKey.toBase58(),stage:'reserved'}
    const sealed=codec.seal(bound,signers)
    const {rows:[saved]}=await db.query(`insert into hook_lab_native_signer_custody
     (operation_id,custody_session_id,owner_wallet,profile_sha256,mint,selected_config,stage,sealed_signers)
     values($1,$2,$3,$4,$5,$6,'reserved',$7) returning *`,[operationId,bound.custodySessionId,owner,profileSha256,bound.mint,bound.selectedConfig,sealed])
    return summary(saved)
 }
 return Object.freeze({
  // Server-only new-mint reservation. A durable operation always reuses its pair.
  // Tests inject deterministic signers; production key generation has no route/config here.
  async reserveNewCandidate(sessionToken,operationId,profileSha256){
   return transaction(sessionToken,operationId,async(db,row,owner)=>{
    z.string().regex(/^[a-f0-9]{64}$/).parse(profileSha256)
    if(row){check(row.profile_sha256===profileSha256);const recovered=codec.open(identity(row),row.sealed_signers);wipe(recovered);return summary(row)}
    const signers=await signerFactory()
    try{return await saveNew(db,operationId,profileSha256,owner,signers)}finally{wipe(signers)}
   })
  },
  // Signers must originate in trusted server memory. Never bind this method to JSON input.
  async retainServerSigners(sessionToken,operationId,profileSha256,signers){
   return transaction(sessionToken,operationId,async(db,row,owner)=>{
    z.string().regex(/^[a-f0-9]{64}$/).parse(profileSha256)
    if(row){check(row.profile_sha256===profileSha256&&row.mint===signers.mint.publicKey.toBase58()&&row.selected_config===signers.selectedConfig.publicKey.toBase58());const recovered=codec.open(identity(row),row.sealed_signers);wipe(recovered);return summary(row)}
    return saveNew(db,operationId,profileSha256,owner,signers)
   })
  },
  async get(sessionToken,operationId){return transaction(sessionToken,operationId,async(_db,row)=>{check(row);const recovered=codec.open(identity(row),row.sealed_signers);wipe(recovered);return summary(row)})},
  async advanceCandidate(sessionToken,operationId,{expectedRevision,stage,evidenceSha256}){
   return transaction(sessionToken,operationId,async(db,row)=>{
    z.string().regex(/^(0|[1-9]\d*)$/).parse(expectedRevision);z.string().regex(/^[a-f0-9]{64}$/).parse(evidenceSha256)
    check(row&&String(row.revision)===expectedRevision&&edges[row.stage].includes(stage))
    const recovered=codec.open(identity(row),row.sealed_signers)
    let sealed;try{sealed=codec.seal({...identity(row),stage},recovered)}finally{wipe(recovered)}
    const {rows:[saved]}=await db.query(`update hook_lab_native_signer_custody set stage=$2,sealed_signers=$3,evidence_sha256=$4,
     revision=revision+1,updated_at=clock_timestamp() where operation_id=$1 returning *`,[operationId,stage,sealed,evidenceSha256])
    return summary(saved)
   })
  },
  // Bind the chosen hook before its hook-specific registry exists. A restart must recover the
  // same mint and intent; reserving is not a successful chain review or signing authorization.
  async retainPreparationIntent(sessionToken,operationId,{expectedRevision,request}){
   return transaction(sessionToken,operationId,async(db,row)=>{
    const parsed=selectedHookPreparationRequestSchema.parse(request)
    check(row&&String(row.revision)===expectedRevision&&row.stage==='reserved')
    check(parsed.creator===row.owner_wallet&&parsed.feePayer===row.owner_wallet&&parsed.mint===row.mint&&parsed.selectedConfig===row.selected_config)
    if(row.preparation_request){check(isDeepStrictEqual(row.preparation_request,parsed));return summary(row)}
    const {rows:[saved]}=await db.query(`update hook_lab_native_signer_custody set preparation_request=$2,
     revision=revision+1,updated_at=clock_timestamp() where operation_id=$1 returning *`,[operationId,parsed])
    return summary(saved)
   })
  },
  async retainPreparationReview(sessionToken,operationId,{expectedRevision,request,evidenceSha256}){
   return transaction(sessionToken,operationId,async(db,row)=>{
    const parsed=parseRequest(request)
    z.string().regex(/^[a-f0-9]{64}$/).parse(evidenceSha256)
    check(row&&String(row.revision)===expectedRevision&&['reserved','preparation-reviewed'].includes(row.stage))
    check(parsed.creator===row.owner_wallet&&parsed.feePayer===row.owner_wallet&&parsed.mint===row.mint&&parsed.selectedConfig===row.selected_config)
    check(!row.preparation_request||isDeepStrictEqual(row.preparation_request,parsed))
    const recovered=codec.open(identity(row),row.sealed_signers)
    let sealed;try{sealed=codec.seal({...identity(row),stage:'preparation-reviewed'},recovered)}finally{wipe(recovered)}
    const {rows:[saved]}=await db.query(`update hook_lab_native_signer_custody set stage='preparation-reviewed',preparation_request=$2,sealed_signers=$3,evidence_sha256=$4,
     revision=revision+1,updated_at=clock_timestamp() where operation_id=$1 returning *`,[operationId,parsed,sealed,evidenceSha256])
    return summary(saved)
   })
  },
  async rotateKey(sessionToken,operationId,expectedRevision){
   return transaction(sessionToken,operationId,async(db,row)=>{
    check(row&&String(row.revision)===expectedRevision)
    const sealed=codec.rotate(identity(row),row.sealed_signers)
    const {rows:[saved]}=await db.query('update hook_lab_native_signer_custody set sealed_signers=$2,revision=revision+1,updated_at=clock_timestamp() where operation_id=$1 returning *',[operationId,sealed])
    return summary(saved)
   })
  },
 })
}
