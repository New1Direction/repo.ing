// Owner-agent verification. Runs on the owner's Mac before the admin key signs anything.
// It trusts nothing the server says about a sign request: it decodes the exact message bytes,
// resolves lookup tables independently, and checks them against the launch the owner invited.
import { createHash,createPrivateKey,sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AddressLookupTableAccount,PublicKey,VersionedMessage } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
const COMPUTE_BUDGET='ComputeBudget111111111111111111111111111111'
const launchIdl=JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_launch.json',import.meta.url)))
const coder=new BorshCoder(launchIdl)
const createLaunch=launchIdl.instructions.find(i=>i.name==='create_launch_custom_v3')
export const CREATE_LAUNCH_DISCRIMINATOR=Buffer.from(createLaunch.discriminator)
const refuse=reason=>Object.assign(Error(`Refused: ${reason}`),{code:'OWNER_AGENT_REFUSED'})
const need=(ok,reason)=>{if(!ok)throw refuse(reason)}
const num=value=>BigInt(value?.toString?.()??value)

export function decodeLookupTable(address,data){
 return new AddressLookupTableAccount({key:new PublicKey(address),state:AddressLookupTableAccount.deserialize(Uint8Array.from(data))})
}

// signRequest: {messageBase64,messageSha256,signer,validUntilSlot,lastValidBlockHeight}
// invited: {creator,name,symbol,uri}; approved: {launchProgram,admin,creatorFeeBps,feeModel}
// lookupTables: AddressLookupTableAccount[] resolved by the agent itself
// live: {slot,blockHeight} observed by the agent itself
export function verifyLaunchSignRequest({signRequest,invited,approved,lookupTables,live,marginSlots=12,marginBlocks=12}){
 const bytes=Buffer.from(signRequest.messageBase64,'base64')
 need(createHash('sha256').update(bytes).digest('hex')===signRequest.messageSha256,'message hash differs')
 need(signRequest.signer===approved.admin,'signer is not the configured admin')
 const message=VersionedMessage.deserialize(bytes)
 need(message.version===0&&Buffer.from(message.serialize()).equals(bytes),'not a canonical v0 message')
 const statics=message.staticAccountKeys.map(k=>k.toBase58()),signers=statics.slice(0,message.header.numRequiredSignatures)
 need(signers.includes(approved.admin),'admin is not a required signer')
 need(statics[0]===invited.creator,'fee payer is not the invited creator')
 need(message.addressTableLookups.every(l=>lookupTables.some(t=>t.key.equals(l.accountKey))),'unresolved lookup table')
 const keys=message.getAccountKeys({addressLookupTableAccounts:lookupTables})
 const programs=message.compiledInstructions.map(ix=>keys.get(ix.programIdIndex).toBase58())
 need(programs.every(p=>p===COMPUTE_BUDGET||p===approved.launchProgram),'message calls a program other than compute budget and launch')
 const launches=message.compiledInstructions.filter((_,i)=>programs[i]===approved.launchProgram)
 need(launches.length===1,'expected exactly one launch instruction')
 const ix=launches[0],data=Buffer.from(ix.data)
 need(data.subarray(0,8).equals(CREATE_LAUNCH_DISCRIMINATOR),'instruction is not create_launch_custom_v3')
 const decoded=coder.instruction.decode(data)
 need(decoded?.name==='create_launch_custom_v3','launch arguments do not decode')
 const {args,guard,fee_model:feeModel}=decoded.data
 need(keys.get(ix.accountKeyIndexes[0]).toBase58()===invited.creator,'launch creator is not the invited creator')
 need(args.name===invited.name&&args.symbol===invited.symbol&&args.uri===invited.uri,'coin name, symbol or URI differs from the invited request')
 need(args.creator_fee_bps===approved.creatorFeeBps&&feeModel===approved.feeModel,'creator fee or fee model differs from the approved economics')
 need(num(guard.deadline_slot)===num(signRequest.validUntilSlot),'deadline differs from the request')
 need(BigInt(live.slot)<num(signRequest.validUntilSlot)-BigInt(marginSlots),'deadline slot too close or passed')
 need(BigInt(live.blockHeight)<num(signRequest.lastValidBlockHeight)-BigInt(marginBlocks),'blockhash too close to expiry')
 return Object.freeze({creator:invited.creator,mint:keys.get(ix.accountKeyIndexes[3]).toBase58(),name:args.name,symbol:args.symbol,uri:args.uri,
  creatorFeeBps:args.creator_fee_bps,feeModel,virtualQuote:args.virtual_quote.toString(),deadlineSlot:guard.deadline_slot.toString(),
  slotsLeft:(num(signRequest.validUntilSlot)-BigInt(live.slot)).toString(),blocksLeft:(num(signRequest.lastValidBlockHeight)-BigInt(live.blockHeight)).toString()})
}

// keypairJson: the Solana keypair array served by the owner's key pipe. Never logged or stored.
export function adminSignerFromKeypair(keypairJson,expectedAddress){
 const bytes=Uint8Array.from(JSON.parse(keypairJson)),seed=Buffer.from(bytes.subarray(0,32))
 const address=new PublicKey(bytes.subarray(32,64)).toBase58()
 need(bytes.length===64&&address===expectedAddress,'key pipe does not hold the configured admin key')
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'})
 seed.fill(0);bytes.fill(0)
 return Object.freeze({address,signBase64:message=>sign(null,Buffer.from(message),key).toString('base64')})
}
