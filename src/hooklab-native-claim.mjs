// Creator fee claims for native-SOL launches (hook-lab claim_creator_fees_sol, design §4.4, review E2-2). A native
// launch's creator fees are lamports on its launch account: what the creator can claim is that account's lamports above
// its rent-exempt minimum, read live (never creator_fees_accrued - claimed, which donations make wrong). The creator
// signs alone and is paid. Pure: no RPC, keys or sending. Compile from two-provider finalized observations; verify a
// finalized receipt from its exact lamport deltas and the CreatorFeesClaimedSol event.
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
export const nativeClaimRequestSchema = z.object({ schema: z.literal('repoing/hooklab-native-claim-request/1'), creator: key, mint: key }).strict()
export const launchAddress = (programs, mint) => pda(programs.launch, 'launch', kb(mint))

// Every account a claim review reads, in a fixed order.
export function nativeClaimInventory(profile, requestInput) {
  const r = nativeClaimRequestSchema.parse(requestInput), L = profile.programs.launch
  return [...new Set([r.creator, launchAddress(profile.programs, r.mint), L, pda(LOADER, kb(L))])].sort()
}

// The launch account as the native program writes it, or a refusal the creator can read.
function nativeLaunch(account, programs, r) {
  check(account && account.owner === programs.launch && !account.executable, 'Launch account is missing or not owned by the launch program')
  const bytes = Buffer.from(account.dataBase64, 'base64')
  check(bytes.length === LAUNCH_ACCOUNT_BYTES, 'Launch account size differs')
  const native = launchIsNative(bytes), launch = loadNativeArtifacts().coders.launch.accounts.decode('Launch', bytes)
  check(launch.mint.toBase58() === r.mint, 'Launch account is not this coin\'s')
  refuse(native, 'This coin\'s creator fees are paid in Hook Lab SOL, so there is nothing to claim here.')
  refuse(launch.creator.toBase58() === r.creator, 'Only the wallet that launched this coin can claim its fees.')
  return launch
}

/** input: { profile: { genesisHash, programs, profileSha256, providers }, request, observations[2],
 * rent: { launchLamports, walletLamports }, recentBlockhash, limits }. */
export function compileNativeClaimReview(input) {
  const { profile, observations: obs, rent, recentBlockhash: bh, limits: l } = input
  const r = nativeClaimRequestSchema.parse(input.request), p = profile.programs, inventory = nativeClaimInventory(profile, r)
  check(Array.isArray(obs) && obs.length === 2 && new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => profile.providers.includes(o.provider)), 'Two independent observations required')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && isDeepStrictEqual(obs[0].accounts, obs[1].accounts), 'Claim state observations disagree')
  for (const o of obs) check(o.genesisHash === profile.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain claim observation')
  const accounts = new Map(obs[0].accounts.map(x => [x.address, x.account]))
  check(isDeepStrictEqual([...accounts.keys()].sort(), inventory), 'Incomplete, duplicate or extra claim inventory')
  const wallet = accounts.get(r.creator), program = accounts.get(p.launch), programData = accounts.get(pda(LOADER, kb(p.launch)))
  refuse(wallet && wallet.owner === SYSTEM && !wallet.executable && Buffer.from(wallet.dataBase64, 'base64').length === 0, 'Use a regular wallet (Phantom, Solflare or Backpack) to claim.')
  const link = program && Buffer.from(program.dataBase64, 'base64')
  check(program && program.owner === LOADER && program.executable && link.length === 36 && link.readUInt32LE(0) === 2 && link.subarray(4).equals(kb(pda(LOADER, kb(p.launch)))), 'Launch program link differs')
  // Only the reviewed native build pays claims this way (and only it can have written a native launch).
  check(programData && programData.owner === LOADER && nativeProgramDataMatches('launch', Buffer.from(programData.dataBase64, 'base64')), 'The launch program is not the reviewed native-SOL build')
  const launchKey = launchAddress(p, r.mint), launch = nativeLaunch(accounts.get(launchKey), p, r)
  const claimable = BigInt(accounts.get(launchKey).lamports) - BigInt(rent.launchLamports)
  refuse(claimable > 0n, 'Nothing to claim yet. Fees arrive with every buy and sell of your coin.')
  const priority = (BigInt(CLAIM_COMPUTE_UNITS) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  const networkFee = BigInt(bh.lamportsPerSignature) + priority
  check(BigInt(bh.networkFeeLamports) === networkFee && networkFee <= BigInt(l.maxNetworkFeeLamports), 'Network fee differs from its explicit basis')
  refuse(claimReceives(claimable, networkFee) > 0n, 'Not enough to claim yet: your fees would barely cover the network fee. Claim once more trades have paid you.')
  // The fee is paid before the claim lands; the claim refuses a recipient left below rent (RecipientBelowRent).
  refuse(BigInt(wallet.lamports) >= networkFee && BigInt(wallet.lamports) - networkFee + claimable >= BigInt(rent.walletLamports), 'Your wallet needs a little SOL (about 0.001) for the network fee.')
  const slot = Math.max(...obs.map(o => o.slot))
  check(bh.genesisHash === profile.genesisHash && isDeepStrictEqual(bh.providers, profile.providers) && l.nowMs >= bh.observedAtMs
    && l.nowMs - bh.observedAtMs <= l.maxAgeMs && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review blockhash or offchain lifetime differs')
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: CLAIM_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }), claimCreatorFeesSol({ launchProgram: p.launch, creator: r.creator, mint: r.mint })]
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
  const quote = { claimableLamports: String(claimable), receiveLamports: String(claimReceives(claimable, networkFee)), launch: launchKey, launchRentLamports: String(rent.launchLamports), networkFeeLamports: String(networkFee),
    walletLamportsBefore: String(wallet.lamports), creatorFeesClaimedBefore: launch.creator_fees_claimed.toString() }
  return Object.freeze({ schema: 'repoing/hooklab-native-claim-review/1', request: r, review, quote, instructions: inspected.instructions })
}

// The one CreatorFeesClaimedSol the claim emitted by self-CPI (launch program to itself, signed by its event authority).
function claimEvent(tx, launchProgram) {
  const events = [], eventAuthority = pda(launchProgram, '__event_authority'), coder = loadNativeArtifacts().coders.launch
  for (const group of tx.innerInstructions) for (const ix of group.instructions) {
    if (tx.keys[ix.programIdIndex] !== launchProgram) continue
    const bytes = Buffer.from(bs58.decode(ix.data))
    check(group.index === 2 && ix.stackHeight === 2 && bytes.subarray(0, 8).equals(EVENT_TAG) && ix.accounts.length === 1 && tx.keys[ix.accounts[0]] === eventAuthority, 'Unexpected launch inner instruction')
    const decoded = coder.events.decode(bytes.subarray(8).toString('base64'))
    check(decoded && Buffer.concat([EVENT_TAG, Buffer.from(loadNativeArtifacts().idls.launch.events.find(e => e.name === decoded.name).discriminator), coder.types.encode(decoded.name, decoded.data)]).equals(bytes), 'Noncanonical event')
    events.push(decoded)
  }
  check(events.length === 1 && events[0].name === 'CreatorFeesClaimedSol', 'Expected exactly one CreatorFeesClaimedSol')
  return events[0].data
}

/** A finalized claim receipt (both providers' identical evidence) against its compiled plan: the exact signed wire was
 * checked by the caller; here the money. Failure: only the fee moved. Success: the launch account fell to its rent, the
 * creator gained exactly that minus the fee, nothing else moved, and the event says the same. */
export function verifyNativeClaimReceipt({ plan, rent, programs, tx }) {
  const review = plan.review, fee = BigInt(inspectHookLabMessage(review).totalFeeLamports), launch = plan.quote.launch, creator = plan.request.creator
  check(BigInt(tx.fee) === fee && tx.pre.length === tx.keys.length && tx.post.length === tx.keys.length, 'Receipt fee or balances differ')
  const delta = address => { const i = tx.keys.indexOf(address); return i < 0 ? 0n : BigInt(tx.post[i]) - BigInt(tx.pre[i]) }
  if (tx.error !== null) {
    check(tx.keys.every(k => delta(k) === (k === review.payer ? -fee : 0n)), 'A failed claim moved more than its fee')
    return { executed: false }
  }
  const event = claimEvent(tx, programs.launch), claimed = BigInt(event.lamports.toString())
  check(event.launch.toBase58() === launch && event.mint.toBase58() === plan.request.mint && event.creator.toBase58() === creator, 'Claim event names another launch or creator')
  check(claimed > 0n && BigInt(event.claimed_total.toString()) >= claimed, 'Claim event amount differs')
  check(-delta(launch) === claimed && BigInt(tx.post[tx.keys.indexOf(launch)]) === BigInt(rent.launchLamports), 'The launch account did not fall to its rent')
  check(delta(creator) === claimed - fee && tx.keys.every(k => [launch, creator].includes(k) || delta(k) === 0n), 'Receipt lamport movements differ from the claim')
  return { executed: true, claimedLamports: String(claimed), claimedTotal: event.claimed_total.toString() }
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
  const receive = claimReceives(claimable, networkFeeLamports)
  return Object.freeze({ mint, native, creator: launch.creator.toBase58(), claimableLamports: String(claimable), networkFeeLamports: String(BigInt(networkFeeLamports)),
    receiveLamports: String(receive), ready: receive > 0n })
}
