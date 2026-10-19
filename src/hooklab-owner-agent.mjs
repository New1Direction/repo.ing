// Owner-agent verification. Runs on the owner's Mac before the admin key signs anything.
// It trusts nothing the server says about a sign request: it decodes the exact message bytes,
// resolves lookup tables independently, and checks them against the launch the owner invited.
import { createHash,createPrivateKey,sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AddressLookupTableAccount,PublicKey,VersionedMessage } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { STANDARD_VIRTUAL_QUOTE,checkLaunchPricing,formatSolPrice,launchVirtualQuote,ownerPricingLine,solUsdQuorum } from './hooklab-launch-pricing.mjs'
import { checkLiveBounds } from './hooklab-launch-bounds.mjs'
import { loadNativeArtifacts } from './hooklab-native-pins.mjs'
import { CREATE_LAUNCH_V4_DISCRIMINATOR,QUOTE_FORM_NATIVE } from './hooklab-native-launch.mjs'
import { maxWalletLaunchAccounts } from './hooklab-max-wallet-launch.mjs'
const COMPUTE_BUDGET='ComputeBudget111111111111111111111111111111'
const launchIdl=JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_launch.json',import.meta.url)))
const coder=new BorshCoder(launchIdl)
const gateCoder=new BorshCoder(JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/hook_max_wallet.json',import.meta.url))))
export const policyAddress=(gateProgram,mint)=>PublicKey.findProgramAddressSync([Buffer.from('policy-v2'),new PublicKey(mint).toBuffer()],new PublicKey(gateProgram))[0].toBase58()
const createLaunch=launchIdl.instructions.find(i=>i.name==='create_launch_custom_v3')
export const CREATE_LAUNCH_DISCRIMINATOR=Buffer.from(createLaunch.discriminator)
// The 32 accounts create_launch_custom_v3 declares plus its 10 remaining ones (creation controls, reviewer, gate program
// data, the gate's slice and the fee policy last); v4 has exactly the same list. Account 29 is the selected config.
const LAUNCH_ACCOUNTS=createLaunch.accounts.length+10,SELECTED_CONFIG=29
const DERIVED='launch accounts differ from the ones this agent derives from its own launch config read (treasury, configs, governance, programs, the mint\'s launch, pool and policies)'
export { CREATE_LAUNCH_V4_DISCRIMINATOR }
const refuse=reason=>Object.assign(Error(`Refused: ${reason}`),{code:'OWNER_AGENT_REFUSED'})
const need=(ok,reason)=>{if(!ok)throw refuse(reason)}
const num=value=>BigInt(value?.toString?.()??value)

export function decodeLookupTable(address,data){
 return new AddressLookupTableAccount({key:new PublicKey(address),state:AddressLookupTableAccount.deserialize(Uint8Array.from(data))})
}

// The opening price an invite fixed. The chain has no price oracle: the agent re-derives the server's price from its
// sources (refusing one that does not reproduce), and an invite without a price launches at the standard 1 SOL quote.
export const invitedVirtualQuote=request=>request?.pricing?checkLaunchPricing(request.pricing).virtualQuote:STANDARD_VIRTUAL_QUOTE
// The agent's own SOL read (src/sol-usd-sources.mjs, from the owner's Mac): a server price that is consistent with its
// claimed sources but more than 3% from what this Mac reads is never recorded, so a server cannot invent a price.
// 3%, not the 2% quorum spread, because the two reads are seconds apart.
export function checkInvitePriceAgainst(pricing,ownReadings){
 if(!pricing)return null
 const own=solUsdQuorum(ownReadings),server=BigInt(pricing.solUsdMicros),mine=BigInt(own.solUsdMicros)
 const [lo,hi]=server<mine?[server,mine]:[mine,server]
 need(hi*10000n<=lo*10300n,`server SOL price ${formatSolPrice(server)} is more than 3% from this Mac's ${formatSolPrice(mine)}`)
 return own
}
// Before an invite: the opening this Mac expects (its own SOL read when the server prices invites, else the standard
// quote) must fit the live on-chain limits, so the agent never asks for an invite the chain would refuse.
export function checkBeforeInvite({priced,ownReadings,bounds}){
 const quote=priced?launchVirtualQuote(solUsdQuorum(ownReadings).solUsdMicros):STANDARD_VIRTUAL_QUOTE
 checkLiveBounds(quote,bounds);return quote
}
// After: the server's price re-derives, is within 3% of this Mac's read, and its quote fits the same live limits.
// Returns the quote the invite ledger records.
export function checkAfterInvite({confirmed,ownReadings,bounds}){
 const quote=invitedVirtualQuote(confirmed)
 if(confirmed.pricing)checkInvitePriceAgainst(confirmed.pricing,ownReadings)
 checkLiveBounds(quote,bounds);return quote
}
// Extra list rows for one request: the fixed price, or when it will be fixed. Nothing while USD pricing is off.
export function ownerRequestLines(request){
 if(request.pricing===undefined)return []
 if(request.pricing)try{invitedVirtualQuote(request);return [`    ${ownerPricingLine(request.pricing)}`]}catch(error){return [`    price: REFUSED, nothing will be signed (${error.message})`]}
 return [request.status==='queued'?'    price: fixed from the live SOL price when you invite':'    price: standard 1 SOL virtual quote (invited before USD pricing)']
}

// signRequest: {messageBase64,messageSha256,signer,validUntilSlot,lastValidBlockHeight}
// invited: {creator,name,symbol,uri,creatorFeeBps,capBps,virtualQuote} (virtualQuote from the agent's own invite ledger)
// approved: {launchProgram,gateProgram,admin,creatorFeeChoices,capChoices,feeModel}
// policy: {address,owner,data} of the mint's PolicyV2, read by the agent itself
// lookupTables: AddressLookupTableAccount[] resolved by the agent itself
// live: {slot,blockHeight} observed by the agent itself
// nativeLaunches: launch Config byte 186 as the agent itself read it from both of its providers (readLiveNativeLaunches).
//  Off: only create_launch_custom_v3, as before. On: only create_launch_custom_v4 with the native quote form.
// envelope, launchConfigBytes: the agent's pinned release envelope and the launch Config it read itself (with the switch).
// selectedConfig: {address,owner,data} of the launch config the message names (account 29), read by the agent itself: the
//  creator's own, with the invited fee and the gate as its hook.
//  Both routes: the launch instruction's 42 accounts, with their signer and writable flags, must be exactly the ones the
//  agent derives from these (review F3), which pins the treasury, configs, governance, programs, and the mint's launch,
//  pool and policies. Every invite check applies as well.
export function verifyLaunchSignRequest({signRequest,invited,approved,lookupTables,policy,live,nativeLaunches=false,envelope,launchConfigBytes,selectedConfig,marginSlots=12,marginBlocks=12}){
 need(nativeLaunches===true||nativeLaunches===false,'the native-launches switch was not read')
 need(approved.creatorFeeChoices.includes(invited.creatorFeeBps)&&approved.capChoices.includes(invited.capBps),'invited fee or cap is not an approved choice')
 need(/^[1-9]\d{0,19}$/.test(invited.virtualQuote??''),'invited opening price is missing')
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
 const ix=launches[0],data=Buffer.from(ix.data),v3=data.subarray(0,8).equals(CREATE_LAUNCH_DISCRIMINATOR),v4=data.subarray(0,8).equals(CREATE_LAUNCH_V4_DISCRIMINATOR)
 if(nativeLaunches)need(v4,v3?'native launches are on: refusing a bridged create_launch_custom_v3':'instruction is not create_launch_custom_v4')
 else need(v3,v4?'native launches are off on chain: refusing create_launch_custom_v4':'instruction is not create_launch_custom_v3')
 const name=v4?'create_launch_custom_v4':'create_launch_custom_v3',launchCoder=v4?loadNativeArtifacts().coders.launch:coder,decoded=launchCoder.instruction.decode(data)
 need(decoded?.name===name,'launch arguments do not decode')
 const {args,guard,fee_model:feeModel,quote_form:quoteForm}=decoded.data
 if(v4)need(quoteForm===QUOTE_FORM_NATIVE&&launchCoder.instruction.encode(name,decoded.data).equals(data),'quote form is not native SOL, or the launch data is not canonical')
 need(keys.get(ix.accountKeyIndexes[0]).toBase58()===invited.creator,'launch creator is not the invited creator')
 need(args.name===invited.name&&args.symbol===invited.symbol&&args.uri===invited.uri,'coin name, symbol or URI differs from the invited request')
 need(args.creator_fee_bps===invited.creatorFeeBps&&feeModel===approved.feeModel,'creator fee or fee model differs from the approved economics')
 need(args.virtual_quote.toString()===invited.virtualQuote,'opening price (virtual quote) differs from the invited request')
 need(ix.accountKeyIndexes.length===LAUNCH_ACCOUNTS,DERIVED)
 const at=i=>keys.get(ix.accountKeyIndexes[i]).toBase58(),mint=at(3)
 // The selected config is the one the message names, and only if this agent's own read shows it is the invited creator's.
 let selected
 try{need(selectedConfig&&selectedConfig.address===at(SELECTED_CONFIG)&&selectedConfig.owner===approved.launchProgram,'');selected=coder.accounts.decode('LaunchConfig',Buffer.from(selectedConfig.data))}
 catch{throw refuse('the selected launch config is not one this agent read for this launch')}
 need(selected.version===1&&selected.creator.toBase58()===invited.creator&&selected.creator_fee_bps===invited.creatorFeeBps&&selected.custom_hook?.toBase58()===approved.gateProgram
  &&selected.custom_hook_flags===1&&selected.author_share_bps===0,'the selected launch config is not the invited creator\'s, with the invited fee and the gate')
 let expected
 try{
  const programs=JSON.parse(envelope.json).programs
  need(programs.launch===approved.launchProgram&&programs.gate===approved.gateProgram,'')
  expected=maxWalletLaunchAccounts(envelope,{creator:invited.creator,mint,selectedConfig:at(SELECTED_CONFIG),reviewer:approved.admin},launchConfigBytes)
 }catch{throw refuse('the agent cannot derive the launch accounts from its own launch config read and envelope')}
 // An account listed twice (the launch) carries the union of its privileges in the message, as Solana compiles it.
 const union=(address,flag)=>expected.some(m=>m.address===address&&m[flag])
 need(expected.length===LAUNCH_ACCOUNTS&&expected.every((m,i)=>{const k=ix.accountKeyIndexes[i]
  return keys.get(k).toBase58()===m.address&&message.isAccountSigner(k)===union(m.address,'signer')&&message.isAccountWritable(k)===union(m.address,'writable')}),DERIVED)
 need(policy&&policy.address===policyAddress(approved.gateProgram,mint)&&policy.owner===approved.gateProgram,'mint policy missing or not owned by the gate')
 const p=gateCoder.accounts.decode('PolicyV2',Buffer.from(policy.data))
 need(p.version===2&&p.mint.toBase58()===mint&&p.cap_bps===invited.capBps&&p.creator_fee_bps===invited.creatorFeeBps&&p.fee_model===2&&p.protocol_share_bps===2500,
  'on-chain wallet cap or fee policy differs from the invited request')
 need(num(guard.deadline_slot)===num(signRequest.validUntilSlot),'deadline differs from the request')
 need(BigInt(live.slot)<num(signRequest.validUntilSlot)-BigInt(marginSlots),'deadline slot too close or passed')
 need(BigInt(live.blockHeight)<num(signRequest.lastValidBlockHeight)-BigInt(marginBlocks),'blockhash too close to expiry')
 return Object.freeze({creator:invited.creator,mint,capBps:p.cap_bps,name:args.name,symbol:args.symbol,uri:args.uri,quoteForm:v4?QUOTE_FORM_NATIVE:null,
  creatorFeeBps:args.creator_fee_bps,feeModel,virtualQuote:args.virtual_quote.toString(),deadlineSlot:guard.deadline_slot.toString(),
  slotsLeft:(num(signRequest.validUntilSlot)-BigInt(live.slot)).toString(),blocksLeft:(num(signRequest.lastValidBlockHeight)-BigInt(live.blockHeight)).toString()})
}

// The mint of the message's single launch instruction (account 3), for reading its policy.
export function launchMintFromMessage(messageBase64,lookupTables,launchProgram){
 const message=VersionedMessage.deserialize(Buffer.from(messageBase64,'base64')),keys=message.getAccountKeys({addressLookupTableAccounts:lookupTables})
 const launches=message.compiledInstructions.filter(ix=>keys.get(ix.programIdIndex).toBase58()===launchProgram)
 need(launches.length===1,'expected exactly one launch instruction')
 return keys.get(launches[0].accountKeyIndexes[3]).toBase58()
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
