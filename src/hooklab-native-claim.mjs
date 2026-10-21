// Creator fee claims for native-SOL launches (hook-lab claim_creator_fees_sol, design §4.4, review E2-2). A native
// launch's creator fees are lamports on its launch account: what the creator can claim is that account's lamports above
// its rent-exempt minimum, read live (never creator_fees_accrued - claimed, which donations make wrong). The creator
// or config author signs alone; the full balance is split between fixed creator/author/partner
// destinations, independently flooring each share with no second protocol charge. Compilation
// and receipt verification are pure; readNativeClaimStatus below is a display-only RPC adapter.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { ComputeBudgetProgram, PublicKey, TransactionMessage } from '@solana/web3.js'
import { z } from 'zod'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { loadNativeArtifacts } from './hooklab-native-pins.mjs'
import { LAUNCH_ACCOUNT_BYTES, claimCreatorFeesSol, launchIsNative, nativeProgramDataMatches } from './hooklab-native-launch.mjs'
import { refuse } from './hooklab-wallet-funding.mjs'
import { LOADER, SYSTEM, kb, pda } from './hooklab-owner-driver/pins.mjs'

const check = (ok, message = 'Claim state, intent or pins changed') => { if (!ok) throw Error(message) }
const sha = value => createHash('sha256').update(value).digest('hex')
const key = z.string().max(44).refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
const EVENT_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')
export const CLAIM_STAGE = 'native-claim', CLAIM_OPERATION = 'hooklab-native-claim'
// Two lamport moves and one event self-CPI use about 20k compute units.
export const CLAIM_COMPUTE_UNITS = 60000
// A claim must leave the creator better off by more than this after its network fee (review F2): about two base fees, so a
// claim never costs more than it pays and a few lamports of dust are not worth a wallet signature.
export const CLAIM_MIN_NET_LAMPORTS = 10_000n
// What the creator receives from a claim of `claimable` lamports paying `networkFee`, or 0n when that is not worth claiming.
export const claimReceives = (claimable, networkFee) => { const net = BigInt(claimable) - BigInt(networkFee); return net > CLAIM_MIN_NET_LAMPORTS ? net : 0n }
export const nativeClaimRequestSchema = z.object({ schema: z.literal('repoing/hooklab-native-claim-request/1'), creator: key, mint: key, claimantRole: z.enum(['creator','author']).optional() }).strict()
export const launchAddress = (programs, mint) => pda(programs.launch, 'launch', kb(mint))
const partnerBps=launch=>BigInt(launch.reserved[14]|launch.reserved[15]<<8)
// Pinned 7fde540 PartnerFee wire layout (the older native IDL has no PartnerFee type).
function partnerState(program,launch,accounts){
  const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('partner'),launch.config.toBuffer()],new PublicKey(program))
  check(bump===launch.reserved[16],'Partner bump differs')
  const row=accounts.get(address.toBase58());if(!row)return {address:address.toBase58()}
  const b=Buffer.from(row.dataBase64,'base64')
  check(row.owner===program&&!row.executable&&b.length===116&&b.subarray(0,8).equals(createHash('sha256').update('account:PartnerFee').digest().subarray(0,8))
    &&b[8]===1&&b[9]===bump&&b.subarray(10,42).equals(launch.config.toBuffer())&&b.subarray(84).every(x=>x===0),'Partner account differs')
  return {address:address.toBase58(),wallet:new PublicKey(b.subarray(42,74)).toBase58(),paidTotal:b.readBigUInt64LE(76)}
}

// Every account a claim review reads, in a fixed order.
export function nativeClaimInventory(profile, requestInput, observedAccounts = null) {
  const r = nativeClaimRequestSchema.parse(requestInput), L = profile.programs.launch
  const inventory = [r.creator, launchAddress(profile.programs, r.mint), L, pda(LOADER, kb(L))]
  // Discovery is two-stage: collect the base inventory first, then re-read the complete inventory
  // on both providers. Addresses below come only from owned, decoded accounts, never the request.
  if(observedAccounts){
    const launch=nativeLaunch(observedAccounts.get(inventory[1]),profile.programs,r)
    inventory.push(launch.creator.toBase58())
    if(launch.author_share_bps>0){
      const config=launch.config.toBase58();inventory.push(config)
      const row=observedAccounts.get(config)
      if(row){check(row.owner===L&&!row.executable);inventory.push(loadNativeArtifacts().coders.launch.accounts.decode('LaunchConfig',Buffer.from(row.dataBase64,'base64')).creator.toBase58())}
    }
    if(partnerBps(launch)>0n){const partner=partnerState(L,launch,observedAccounts);inventory.push(partner.address);if(partner.wallet)inventory.push(partner.wallet)}
  }
  return [...new Set(inventory)].sort()
}

// The launch account as the native program writes it, or a refusal the creator can read.
function nativeLaunch(account, programs, r) {
  check(account && account.owner === programs.launch && !account.executable, 'Launch account is missing or not owned by the launch program')
  const bytes = Buffer.from(account.dataBase64, 'base64')
  check(bytes.length === LAUNCH_ACCOUNT_BYTES, 'Launch account size differs')
  const native = launchIsNative(bytes), launch = loadNativeArtifacts().coders.launch.accounts.decode('Launch', bytes)
  check(launch.mint.toBase58() === r.mint, 'Launch account is not this coin\'s')
  refuse(native, 'This coin\'s creator fees are paid in Hook Lab SOL, so there is nothing to claim here.')
  if(r.claimantRole!=='author')refuse(launch.creator.toBase58() === r.creator, 'Only the wallet that launched this coin can claim its fees.')
  return launch
}

/** input: { profile: { genesisHash, programs, profileSha256, providers }, request, observations[2],
 * rent: { launchLamports, walletLamports }, recentBlockhash, limits }. */
export function compileNativeClaimReview(input) {
  const { profile, observations: obs, rent, recentBlockhash: bh, limits: l } = input
  const r = nativeClaimRequestSchema.parse(input.request), p = profile.programs
  check(Array.isArray(obs) && obs.length === 2 && new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => profile.providers.includes(o.provider)), 'Two independent observations required')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && isDeepStrictEqual(obs[0].accounts, obs[1].accounts), 'Claim state observations disagree')
  for (const o of obs) check(o.genesisHash === profile.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain claim observation')
  const accounts = new Map(obs[0].accounts.map(x => [x.address, x.account]))
  const inventory = nativeClaimInventory(profile,r,accounts)
  check(accounts.size===obs[0].accounts.length&&isDeepStrictEqual([...accounts.keys()].sort(), inventory), 'Incomplete, duplicate or extra claim inventory')
  const wallet = accounts.get(r.creator), program = accounts.get(p.launch), programData = accounts.get(pda(LOADER, kb(p.launch)))
  refuse(wallet && wallet.owner === SYSTEM && !wallet.executable && Buffer.from(wallet.dataBase64, 'base64').length === 0, 'Use a regular wallet (Phantom, Solflare or Backpack) to claim.')
  const link = program && Buffer.from(program.dataBase64, 'base64')
  check(program && program.owner === LOADER && program.executable && link.length === 36 && link.readUInt32LE(0) === 2 && link.subarray(4).equals(kb(pda(LOADER, kb(p.launch)))), 'Launch program link differs')
  // Only the reviewed native build pays claims this way (and only it can have written a native launch).
  check(programData && programData.owner === LOADER && nativeProgramDataMatches('launch', Buffer.from(programData.dataBase64, 'base64'), profile.launchElf ?? null), 'The launch program is not the reviewed native-SOL build')
  const launchKey = launchAddress(p, r.mint), launch = nativeLaunch(accounts.get(launchKey), p, r)
  const creator=launch.creator.toBase58(),share=BigInt(launch.author_share_bps)
  check(share>=0n&&share<=10000n)
  let author=null
  if(share>0n){
    const row=accounts.get(launch.config.toBase58());check(row?.owner===p.launch&&!row.executable,'Missing immutable author config')
    const config=loadNativeArtifacts().coders.launch.accounts.decode('LaunchConfig',Buffer.from(row.dataBase64,'base64'))
    author=config.creator.toBase58();check(author!==launchKey&&creator!==launchKey)
  }
  if(r.claimantRole==='author')check(author===r.creator,'Only the immutable config author can claim its share')
  const partner=partnerBps(launch)>0n?partnerState(p.launch,launch,accounts):null
  check(!partner||partner.wallet,'Missing partner wallet')
  const partnerShare=partner?.wallet===launchKey?0n:partnerBps(launch)
  check(share+partnerShare<=10000n,'Claim shares exceed available balance')
  const claimable = BigInt(accounts.get(launchKey).lamports) - BigInt(rent.launchLamports)
  const toAuthor=claimable*share/10000n,toPartner=claimable*partnerShare/10000n,toCreator=claimable-toAuthor-toPartner,signerReceives=(r.creator===creator?toCreator:0n)+(r.creator===author?toAuthor:0n)+(r.creator===partner?.wallet?toPartner:0n)
  refuse(claimable > 0n, 'Nothing to claim yet. Fees arrive with every buy and sell of your coin.')
  const priority = (BigInt(CLAIM_COMPUTE_UNITS) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  const networkFee = BigInt(bh.lamportsPerSignature) + priority
  check(BigInt(bh.networkFeeLamports) === networkFee && networkFee <= BigInt(l.maxNetworkFeeLamports), 'Network fee differs from its explicit basis')
  refuse(claimReceives(signerReceives, networkFee) > 0n, 'Not enough to claim yet: your fees would barely cover the network fee. Claim once more trades have paid you.')
  // The fee is paid before the claim lands; the claim refuses a recipient left below rent (RecipientBelowRent).
  refuse(BigInt(wallet.lamports) >= networkFee && BigInt(wallet.lamports) - networkFee + claimable >= BigInt(rent.walletLamports), 'Your wallet needs a little SOL (about 0.001) for the network fee.')
  const slot = Math.max(...obs.map(o => o.slot))
  check(bh.genesisHash === profile.genesisHash && isDeepStrictEqual(bh.providers, profile.providers) && l.nowMs >= bh.observedAtMs
    && l.nowMs - bh.observedAtMs <= l.maxAgeMs && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review blockhash or offchain lifetime differs')
  const meta=(address,signer=false,writable=false)=>({pubkey:new PublicKey(address),isSigner:signer,isWritable:writable})
  const claimIx=claimCreatorFeesSol({launchProgram:p.launch,creator:r.creator,mint:r.mint})
  if(r.claimantRole==='author'){
    claimIx.keys=[meta(author,true,true),meta(launchKey,false,true),meta(launch.config),meta(creator,false,true),meta(pda(p.launch,'__event_authority')),meta(p.launch)]
    // This discriminator follows the Rust entrypoint; the adopted IDL may predate that entrypoint.
    claimIx.data=createHash('sha256').update('global:claim_author_fees_sol').digest().subarray(0,8)
  }else if(author)claimIx.keys.push(meta(launch.config),meta(author,false,true))
  if(partner)claimIx.keys.push(meta(partner.address,false,true),meta(partner.wallet,false,true))
  for(const address of new Set([creator,...(author?[author]:[]),...(partner&&partner.wallet!==launchKey?[partner.wallet]:[])])){
    const row=accounts.get(address);check(row&&!row.executable&&row.owner===SYSTEM&&Buffer.from(row.dataBase64,'base64').length===0,'Payout requires an empty system wallet')
    const credit=(address===creator?toCreator:0n)+(address===author?toAuthor:0n)+(address===partner?.wallet?toPartner:0n)
    refuse(BigInt(row.lamports)+credit-(address===r.creator?networkFee:0n)>=BigInt(rent.walletLamports),'A payout wallet would remain below rent')
  }
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: CLAIM_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }), claimIx]
  const message = new TransactionMessage({ payerKey: new PublicKey(r.creator), recentBlockhash: bh.blockhash, instructions }).compileToV0Message()
  const keys = message.getAccountKeys(), bytes = message.serialize()
  const review = { schema: 'hooklab-message-review/1', operation: CLAIM_OPERATION, genesisHash: profile.genesisHash, profileSha256: profile.profileSha256,
    policySha256: sha(JSON.stringify(obs)), intentSha256: sha(JSON.stringify(r)), payer: r.creator, wallet: r.creator,
    messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes), requiredSigners: [r.creator],
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: [], observedSlot: bh.observedSlot, validUntilSlot: l.validUntilSlot, observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs,
    lastValidBlockHeight: bh.lastValidBlockHeight, baseFeeLamports: String(bh.lamportsPerSignature), maxFeeLamports: String(networkFee),
    instructionDebitLamports: '0', maxNativeDebitLamports: String(networkFee) }
  const inspected = inspectHookLabMessage(review)
  const canonical = instructions.map(ix => ({ program: ix.programId.toBase58(), dataHex: ix.data.toString('hex'), accounts: ix.keys.map(m => review.accounts.find(a => a.address === m.pubkey.toBase58())) }))
  check(message.header.numRequiredSignatures === 1 && isDeepStrictEqual(inspected.instructions, canonical), 'Compiled claim envelope differs')
  const quote = { claimableLamports: String(claimable), receiveLamports: String(claimReceives(signerReceives, networkFee)), launch: launchKey, launchRentLamports: String(rent.launchLamports), networkFeeLamports: String(networkFee),
    creator,author,authorShareBps:String(share),config:launch.config.toBase58(),creatorLamports:String(toCreator),authorLamports:String(toAuthor),authorFeesPaidBefore:launch.author_fees_paid.toString(),
    ...(partner?{partner:partner.wallet,partnerFee:partner.address,partnerShareBps:String(partnerShare),partnerLamports:String(toPartner),partnerPaidBefore:String(partner.paidTotal)}:{}),
    walletLamportsBefore: String(wallet.lamports), creatorFeesClaimedBefore: launch.creator_fees_claimed.toString() }
  return Object.freeze({ schema: 'repoing/hooklab-native-claim-review/1', request: r, review, quote, instructions: inspected.instructions })
}

// Canonical payout self-CPI events, signed by the launch program's event authority.
function claimEvent(tx, launchProgram, authorShare = false, partnerShare = false) {
  const events = [], eventAuthority = pda(launchProgram, '__event_authority'), coder = loadNativeArtifacts().coders.launch
  for (const group of tx.innerInstructions) for (const ix of group.instructions) {
    if (tx.keys[ix.programIdIndex] !== launchProgram) continue
    const bytes = Buffer.from(bs58.decode(ix.data))
    // Some RPC nodes omit stackHeight: the claim's own top-level instruction (index 2) and the launch program identify
    // the event then, since the claim makes no other call into the launch program. A height, when given, must be 2.
    check(group.index === 2 && (ix.stackHeight === 2 || !authorShare && !partnerShare && (ix.stackHeight === undefined || ix.stackHeight === null))
      && bytes.subarray(0, 8).equals(EVENT_TAG) && ix.accounts.length === 1 && tx.keys[ix.accounts[0]] === eventAuthority, 'Unexpected launch inner instruction')
    // Pinned PartnerFeesPaid schema, absent from the older native artifact's IDL. Decode only
    // its exact event wire, after the same event-authority and ancestry checks as IDL events.
    if(bytes.subarray(8,16).equals(createHash('sha256').update('event:PartnerFeesPaid').digest().subarray(0,8))){
      check(bytes.length===176,'Noncanonical partner event')
      const data={};for(const [i,k] of ['launch','mint','config','partner'].entries())data[k]=new PublicKey(bytes.subarray(16+i*32,48+i*32))
      for(const [i,k] of ['amount','paid_total','slot'].entries())data[k]=bytes.readBigUInt64LE(144+i*8)
      data.ts=bytes.readBigInt64LE(168);events.push({name:'PartnerFeesPaid',data});continue
    }
    const decoded = coder.events.decode(bytes.subarray(8).toString('base64'))
    check(decoded && Buffer.concat([EVENT_TAG, Buffer.from(loadNativeArtifacts().idls.launch.events.find(e => e.name === decoded.name).discriminator), coder.types.encode(decoded.name, decoded.data)]).equals(bytes), 'Noncanonical event')
    events.push(decoded)
  }
  const names=['CreatorFeesClaimedSol',...(authorShare?['AuthorFeesPaid']:[]),...(partnerShare?['PartnerFeesPaid']:[])]
  check(isDeepStrictEqual(events.map(e=>e.name),names),'Expected canonical claim payout events')
  return {event:events[0].data,author:events.find(e=>e.name==='AuthorFeesPaid')?.data,partner:events.find(e=>e.name==='PartnerFeesPaid')?.data}
}

/** A finalized claim receipt (both providers' identical evidence) against its compiled plan: the exact signed wire was
 * checked by the caller; here the money. Failure: only the fee moved. Success: the launch account fell to its rent, the
 * fixed recipients gained their independently floored shares, the payer paid only the network
 * fee, nothing else moved, and each authenticated payout event says the same. */
export function verifyNativeClaimReceipt({ plan, rent, programs, tx }) {
  const review = plan.review, fee = BigInt(inspectHookLabMessage(review).totalFeeLamports), launch = plan.quote.launch, creator = plan.quote.creator??plan.request.creator
  check(BigInt(tx.fee) === fee && tx.pre.length === tx.keys.length && tx.post.length === tx.keys.length&&new Set(tx.keys).size===tx.keys.length, 'Receipt fee or balances differ')
  const delta = address => { const i = tx.keys.indexOf(address); return i < 0 ? 0n : BigInt(tx.post[i]) - BigInt(tx.pre[i]) }
  if (tx.error !== null) {
    check(tx.keys.every(k => delta(k) === (k === review.payer ? -fee : 0n)), 'A failed claim moved more than its fee')
    return { executed: false }
  }
  const share=BigInt(plan.quote.authorShareBps??0),partnerShare=BigInt(plan.quote.partnerShareBps??0),{event,author,partner}=claimEvent(tx,programs.launch,share>0n,!!plan.quote.partner),claimed=BigInt(event.lamports.toString())
  check(event.launch.toBase58() === launch && event.mint.toBase58() === plan.request.mint && event.creator.toBase58() === creator, 'Claim event names another launch or creator')
  const available=-delta(launch),authorAmount=available*share/10000n,partnerAmount=available*partnerShare/10000n
  check(available>0n&&claimed===available-authorAmount-partnerAmount&&BigInt(event.claimed_total.toString())>=claimed,'Claim event amount differs')
  if(author)check(author.launch.toBase58()===launch&&author.mint.toBase58()===plan.request.mint&&author.config.toBase58()===plan.quote.config&&author.author.toBase58()===plan.quote.author
    &&BigInt(author.amount.toString())===authorAmount&&BigInt(author.paid_total.toString())>=authorAmount&&author.slot.toString()===event.slot.toString()&&author.ts.toString()===event.ts.toString(),'Author event differs')
  if(partner)check(partner.launch.toBase58()===launch&&partner.mint.toBase58()===plan.request.mint&&partner.config.toBase58()===plan.quote.config&&partner.partner.toBase58()===plan.quote.partner
    &&partner.amount===partnerAmount&&partner.paid_total>=partnerAmount&&partner.slot.toString()===event.slot.toString()&&partner.ts.toString()===event.ts.toString(),'Partner event differs')
  check(BigInt(tx.post[tx.keys.indexOf(launch)])===BigInt(rent.launchLamports),'The launch account did not fall to its rent')
  const expected=new Map([[launch,-available]])
  for(const [address,amount] of [[creator,claimed],...(author?[[plan.quote.author,authorAmount]]:[]),...(partner?[[plan.quote.partner,partnerAmount]]:[]),[review.payer,-fee]])expected.set(address,(expected.get(address)??0n)+amount)
  check([...expected.keys()].every(k=>tx.keys.includes(k))&&tx.keys.every(k=>delta(k)===(expected.get(k)??0n)),'Receipt lamport movements differ from the claim')
  return { executed: true, claimedLamports: String(claimed), claimedTotal: event.claimed_total.toString(),...(author?{authorLamports:String(authorAmount),authorPaidTotal:author.paid_total.toString()}: {}),...(partner?{partnerLamports:String(partnerAmount),partnerPaidTotal:String(partner.paid_total)}:{}) }
}

// Display only (coin page and My coins): whether this coin's fees are claimable in SOL, by whom, how much right now, and
// what the creator would receive after the claim's network fee (networkFeeLamports, the server's claim fee basis).
// Claims themselves re-read everything on two providers before anything is signed.
export async function readNativeClaimStatus({ connection, mint, programs, networkFeeLamports }) {
  new PublicKey(mint)
  const launchKey = launchAddress(programs, mint)
  const [{ value: [info] }, rentLamports] = await Promise.all([connection.getMultipleAccountsInfoAndContext([new PublicKey(launchKey)], { commitment: 'confirmed' }),
    connection.getMinimumBalanceForRentExemption(LAUNCH_ACCOUNT_BYTES, 'confirmed')])
  if (!info || info.owner.toBase58() !== programs.launch || Buffer.from(info.data).length !== LAUNCH_ACCOUNT_BYTES) return null
  const launch = loadNativeArtifacts().coders.launch.accounts.decode('Launch', Buffer.from(info.data))
  if (launch.mint.toBase58() !== mint) return null
  const native = launchIsNative(Buffer.from(info.data)), above = BigInt(info.lamports) - BigInt(rentLamports), claimable = native && above > 0n ? above : 0n
  const authorAmount=claimable*BigInt(launch.author_share_bps)/10000n,partnerAmount=claimable*partnerBps(launch)/10000n
  const receive = claimReceives(claimable-authorAmount-partnerAmount, networkFeeLamports)
  return Object.freeze({ mint, native, creator: launch.creator.toBase58(), claimableLamports: String(claimable), networkFeeLamports: String(BigInt(networkFeeLamports)),
    receiveLamports: String(receive), ready: receive > 0n })
}
