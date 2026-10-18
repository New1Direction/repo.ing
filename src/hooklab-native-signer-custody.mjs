// SERVER-ONLY opt-in candidate custody. No env/key discovery, wallet/API export,
// transaction signing, broadcast or adoption. Supply a separately approved key ring.
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto'
import { Keypair,PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress } from './hooklab-execution-contract.mjs'
const stages=['reserved','preparation-reviewed','preparation-signed','preparation-finalized','launch-reviewed','launch-signed','launch-finalized','reconcile-required']
export const nativeCustodyIdentitySchema=z.object({schema:z.literal('repoing/native-signer-custody/1'),operationId:z.uuid(),custodySessionId:z.uuid(),
 owner:hookAddress,profileSha256:z.string().regex(/^[a-f0-9]{64}$/),mint:hookAddress,selectedConfig:hookAddress,stage:z.enum(stages)}).strict()
const envelopeSchema=z.object({schema:z.literal('repoing/native-signer-ciphertext/1'),keyId:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
 iv:z.string().max(24),ciphertext:z.string().max(180),tag:z.string().max(24)}).strict()
const fail=()=>Object.assign(Error('Native signer custody unavailable or changed'),{code:'NATIVE_CUSTODY_UNAVAILABLE'})
const bytes=(value,length)=>{const result=Buffer.from(value,'base64');if(result.length!==length||result.toString('base64')!==value)throw fail();return result}
const aad=(identity,keyId)=>Buffer.from(`repo.ing native signer custody v1\0${keyId}\0${JSON.stringify(nativeCustodyIdentitySchema.parse(identity))}`)
function checkSigners(identity,mint,selectedConfig){
 if(mint.publicKey.toBase58()!==identity.mint||selectedConfig.publicKey.toBase58()!==identity.selectedConfig
   ||new Set([identity.owner,identity.mint,identity.selectedConfig]).size!==3)throw fail()
}
export function nativeSignerCustodyCodec({enabled=false,keyRing,activeKeyId}={}){
 let keys
 try{
  if(!keyRing||Object.getPrototypeOf(keyRing)!==Object.prototype||Object.keys(keyRing).length<1||Object.keys(keyRing).length>8)throw fail()
  keys=new Map(Object.entries(keyRing).map(([id,key])=>{if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||!Buffer.isBuffer(key)||key.length!==32)throw fail();return[id,Buffer.from(key)]}))
  if(!keys.has(activeKeyId))throw fail()
 }catch{throw fail()}
 const seal=(input,signers)=>{
  try{
   if(enabled!==true)throw fail()
   const identity=nativeCustodyIdentitySchema.parse(input),mint=Keypair.fromSecretKey(Uint8Array.from(signers.mint.secretKey)),selectedConfig=Keypair.fromSecretKey(Uint8Array.from(signers.selectedConfig.secretKey))
   checkSigners(identity,mint,selectedConfig)
   const plaintext=Buffer.concat([Buffer.from(mint.secretKey),Buffer.from(selectedConfig.secretKey)]),iv=randomBytes(12)
   try{
    const cipher=createCipheriv('aes-256-gcm',keys.get(activeKeyId),iv);cipher.setAAD(aad(identity,activeKeyId))
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()])
    return Object.freeze({schema:'repoing/native-signer-ciphertext/1',keyId:activeKeyId,iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')})
   }finally{plaintext.fill(0);mint.secretKey.fill(0);selectedConfig.secretKey.fill(0)}
  }catch{throw fail()}
 }
 // Internal server memory only; callers must never serialize this return value.
 const open=(input,sealed)=>{
  try{
   if(enabled!==true)throw fail()
   const identity=nativeCustodyIdentitySchema.parse(input),envelope=envelopeSchema.parse(sealed),key=keys.get(envelope.keyId)
   if(!key)throw fail()
   const decipher=createDecipheriv('aes-256-gcm',key,bytes(envelope.iv,12));decipher.setAAD(aad(identity,envelope.keyId));decipher.setAuthTag(bytes(envelope.tag,16))
   const plaintext=Buffer.concat([decipher.update(bytes(envelope.ciphertext,128)),decipher.final()])
   try{
    const mint=Keypair.fromSecretKey(Uint8Array.from(plaintext.subarray(0,64))),selectedConfig=Keypair.fromSecretKey(Uint8Array.from(plaintext.subarray(64)))
    checkSigners(identity,mint,selectedConfig);return{mint,selectedConfig}
   }finally{plaintext.fill(0)}
  }catch{throw fail()}
 }
 return Object.freeze({seal,open,rotate(identity,sealed){const signers=open(identity,sealed);try{return seal(identity,signers)}finally{signers.mint.secretKey.fill(0);signers.selectedConfig.secretKey.fill(0)}}})
}
// A separately configured launch administrator must match freshly observed on-chain
// governance. No platform creator/GitHub identity is silently substituted.
export function verifyNativeAdminSignerIdentity({configuredAdmin,observedAdmin,owner,mint,selectedConfig}){
 try{
  for(const value of [configuredAdmin,observedAdmin,owner,mint,selectedConfig]){hookAddress.parse(value);if(!PublicKey.isOnCurve(new PublicKey(value).toBuffer()))throw fail()}
  if(configuredAdmin!==observedAdmin||new Set([configuredAdmin,owner,mint,selectedConfig]).size!==4)throw fail()
  return Object.freeze({admin:configuredAdmin,canSign:false,canSubmit:false,executionAuthorized:false})
 }catch{throw fail()}
}
