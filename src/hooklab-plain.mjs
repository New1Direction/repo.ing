// Offline production-profile preparation. No active deployment, signing keys or RPC constructors.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { z } from 'zod'
import { PRODUCTION_PROGRAMS, productionCandidateManifest, createLaunchMainnet, mainnetLaunchAddresses,
  creationControlHash, launchEconomicsHash, poolEconomicsHash, decodeLaunchConfig, decodeSwapConfig,
  decodeMint, decodeLaunch, decodePool, decodeHolding, encodeHookAccountList, NO_LAUNCH_RULES } from '@repo-ing/hooklab-production-candidate'
import { inspectHookLabMessage, checkHookLabReviewFreshness, checkHookLabSimulation } from './hooklab-message-boundary.mjs'

export const PLAIN_SOURCE = 'f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32'
export const PLAIN_PROFILE_SHA256 = '9df8e9ceaa3a73fb37c8af35254382f27e38bfc35d6a1fcfa4b72223e75e9cb7'
const sha = b => createHash('sha256').update(b).digest('hex')
const key = z.string().refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const u64 = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const metadata = n => z.string().refine(v => Buffer.byteLength(v) <= n)
const check = (ok, message) => { if (!ok) throw new Error(message) }
const pk = v => new PublicKey(v)
export const plainIntentSchema = z.object({
  schema: z.literal('repoing/plain-intent/1'), creator: key, feePayer: key, mint: key,
  name: metadata(32).refine(v => v.trim().length > 0), symbol: metadata(10).refine(v => v.trim().length > 0),
  uri: metadata(200).refine(v => v === '' || /^https:\/\//.test(v)), virtualQuote: u64,
  deadlineSlot: u64, maxLaunchFeeLamports: u64, maxPoolCreationFeeLamports: u64,
  maxRentLamports: u64, maxInstructionDebitLamports: u64, maxNetworkFeeLamports: u64,
  computeUnitLimit: integer.positive().max(1400000), computeUnitPriceMicroLamports: u64,
}).strict()
const snapshotSchema = z.object({ slot: integer, nowMs: integer, reviewExpiresAtMs: integer,
  blockhash: key, lastValidBlockHeight: integer, networkFeeLamports: u64,
  launchConfigBase64: z.string().max(1024), swapConfigBase64: z.string().max(1024), governanceCommitment: hash,
  creatorGrant: z.object({ creator: key, enabled: z.boolean(), expiresAtSlot: u64, maxLaunches: u64,
    consumed: u64, revision: u64 }).strict(),
  lookupTables: z.array(z.object({ address: key, owner: z.literal('AddressLookupTab1e1111111111111111111111111'),
    dataBase64: z.string().max(16384), sha256: hash }).strict()).max(8),
}).strict()

export function firstCreatorPacket() {
  const profile = productionCandidateManifest()
  return { schema: 'repoing/first-plain-creator/1', status: 'owner-input-required', sourceCommit: PLAIN_SOURCE,
    profileSha256: PLAIN_PROFILE_SHA256, proposedPrograms: profile.programs, genesisHash: profile.genesisHash,
    creator: null, feePayer: null, mint: null, name: null, symbol: null, uri: '',
    economics: null, creatorGrant: null, creationDeadlineSlot: null, networkFeeQuote: null, message: null,
    proposedScope: { creatorFeeBps: 0, rules: 'none', initialBuy: false, liquiditySeeding: false,
      tradingRemainsPaused: true, automaticRetry: false },
    requirements: ['Owner selects creator and metadata; creator pays instruction rent and fees.',
      'Outer fee payer pays network/priority fees; it need not be the creator.',
      'Explicit economics, bounded lifetime grant/exclusive expiry, creation unpause and separate launch approval.',
      'Finalized deployment/dependencies, fresh controls/economics, exact rents/fees and retained message review.'],
    canSign: false, canSubmit: false }
}

/** Pure official builder with explicit production IDs. Snapshots are NOT trusted chain observations.
 * This prepares exact bytes for offline verification; no caller boolean can activate execution.
 */
export function preparePlainReview(input, observation) {
  const intent = plainIntentSchema.parse(input), observed = snapshotSchema.parse(observation)
  const profile = productionCandidateManifest(), programs = PRODUCTION_PROGRAMS
  const launchBytes = Buffer.from(observed.launchConfigBase64, 'base64'), swapBytes = Buffer.from(observed.swapConfigBase64, 'base64')
  check(launchBytes.length === 250 && swapBytes.length === 189 && launchBytes[8] === 1 && swapBytes[8] === 1
    && launchBytes.toString('base64') === observed.launchConfigBase64 && swapBytes.toString('base64') === observed.swapConfigBase64, 'Config size/version differs')
  const launch = decodeLaunchConfig(launchBytes), swap = decodeSwapConfig(swapBytes)
  const grant = observed.creatorGrant, slot = BigInt(observed.slot), deadline = BigInt(intent.deadlineSlot)
  check(!launch.paused, 'Creation is paused; separate unpause approval required')
  check(grant.enabled && grant.creator === intent.creator && slot < BigInt(grant.expiresAtSlot)
    && BigInt(grant.consumed) < BigInt(grant.maxLaunches), 'Creator grant missing, expired or exhausted')
  check(slot <= deadline && deadline < BigInt(grant.expiresAtSlot), 'Deadline outside creator grant')
  check(launch.quoteMint.toBase58() === profile.quoteMint && launch.treasury.toBase58() === profile.requestedRolesNotDeployed.treasuryAndCollector
    && swap.treasury.equals(launch.treasury) && swap.feeCollector.equals(launch.treasury)
    && launch.admin.toBase58() === profile.requestedRolesNotDeployed.ownerAdmin && swap.admin.equals(launch.admin), 'Quote or authority differs')
  check(BigInt(intent.virtualQuote) >= launch.minVirtualQuote && BigInt(intent.virtualQuote) <= launch.maxVirtualQuote, 'Virtual quote outside config bounds')
  check(launch.launchFeeLamports <= BigInt(intent.maxLaunchFeeLamports)
    && swap.poolCreationFeeLamports <= BigInt(intent.maxPoolCreationFeeLamports), 'Program fee exceeds cap')
  check(BigInt(intent.maxRentLamports) + launch.launchFeeLamports + swap.poolCreationFeeLamports <= BigInt(intent.maxInstructionDebitLamports), 'Instruction debit cap is insufficient')
  const guard = { version: 2, deadlineSlot: deadline,
    expectedLaunchEconomicsHash: launchEconomicsHash(launch, 1, pk(intent.creator), null, pk(profile.pdas.launchConfig), programs.launch),
    expectedPoolEconomicsHash: poolEconomicsHash(swap, 1, pk(profile.pdas.swapConfig), programs.swap),
    maxLaunchFeeLamports: BigInt(intent.maxLaunchFeeLamports), maxPoolCreationFeeLamports: BigInt(intent.maxPoolCreationFeeLamports),
    maxRentLamports: BigInt(intent.maxRentLamports), maxTotalDebitLamports: BigInt(intent.maxInstructionDebitLamports) }
  const authorization = { ...grant, creator: pk(grant.creator), expiresAtSlot: BigInt(grant.expiresAtSlot),
    maxLaunches: BigInt(grant.maxLaunches), consumed: BigInt(grant.consumed), revision: BigInt(grant.revision) }
  const control = creationControlHash(Buffer.from(observed.governanceCommitment, 'hex'), authorization, programs.launch)
  const ix = createLaunchMainnet(pk(intent.creator), pk(intent.mint), launch.treasury, launch.quoteMint, launch.lpFeeBps,
    { name: intent.name, symbol: intent.symbol, uri: intent.uri, virtualQuote: BigInt(intent.virtualQuote) }, guard, control, programs)
  const tables = observed.lookupTables.map(t => new AddressLookupTableAccount({ key: pk(t.address), state: AddressLookupTableAccount.deserialize(Buffer.from(t.dataBase64, 'base64')) }))
  const message = new TransactionMessage({ payerKey: pk(intent.feePayer), recentBlockhash: observed.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: intent.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(intent.computeUnitPriceMicroLamports) }), ix,
  ] }).compileToV0Message(tables)
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables })
  const priority = (BigInt(intent.computeUnitLimit) * BigInt(intent.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(BigInt(observed.networkFeeLamports) >= priority, 'Invalid exact network fee quote')
  const review = { schema: 'hooklab-message-review/1', operation: 'plain-launch', genesisHash: profile.genesisHash,
    profileSha256: PLAIN_PROFILE_SHA256, policySha256: sha(JSON.stringify(observed)), intentSha256: sha(JSON.stringify(intent)),
    payer: intent.feePayer, wallet: intent.creator, messageBase64: Buffer.from(message.serialize()).toString('base64'), messageSha256: sha(message.serialize()),
    requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58()),
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: message.addressTableLookups.map(l => observed.lookupTables.find(t => t.address === l.accountKey.toBase58())),
    observedSlot: observed.slot, validUntilSlot: Number(deadline), observedAtMs: observed.nowMs, reviewExpiresAtMs: observed.reviewExpiresAtMs,
    lastValidBlockHeight: observed.lastValidBlockHeight, baseFeeLamports: String(BigInt(observed.networkFeeLamports) - priority),
    maxFeeLamports: intent.maxNetworkFeeLamports, instructionDebitLamports: intent.maxInstructionDebitLamports,
    maxNativeDebitLamports: String(BigInt(intent.maxInstructionDebitLamports) + BigInt(intent.maxNetworkFeeLamports)) }
  inspectHookLabMessage(review)
  return { intent, observed, review, addresses: Object.fromEntries(Object.entries(mainnetLaunchAddresses(pk(intent.mint), launch.quoteMint, launch.lpFeeBps, programs)).map(([k, v]) => [k, v.toBase58()])),
    creatorInstructionDebitCap: intent.maxInstructionDebitLamports, outerPayerNetworkFee: observed.networkFeeLamports,
    sourceCommit: PLAIN_SOURCE, canSign: false, canSubmit: false }
}

/** Injected read-only RPC adapter, used only by offline/local validation until adoption.
 * No key generation, replacement blockhash, signature verification bypass at submission or send.
 */
export async function simulatePlainReview(connection, plan, current) {
  const rebuilt = preparePlainReview(plan.intent, plan.observed)
  check(isDeepStrictEqual(rebuilt, plan), 'Plan changed')
  checkHookLabReviewFreshness(plan.review, current)
  check(await connection.getGenesisHash() === plan.review.genesisHash, 'Wrong RPC network')
  // Keep the wire authoritative, never rebuild for a newer blockhash.
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64')))
  const simulation = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'finalized', minContextSlot: plan.review.observedSlot })
  return checkHookLabSimulation(plan.review, current, { ...simulation, messageSha256: plan.review.messageSha256 })
}

export function refusePlainExecution() {
  throw Object.assign(new Error('Production execution is disabled pending finalized adoption and separate approval.'), { code: 'PRODUCTION_EXECUTION_DISABLED', status: 423 })
}

// Hard code gate intentionally precedes every side effect. No environment/request override.
export async function submitPlainTransaction() {
  refusePlainExecution()
}

/** Exact post-creation state verification only; callers must separately verify receipt/deployment.
 * Later trading or drift is review-required, never a reason to relaunch with another mint.
 */
export function verifyPlainPostconditions(plan, accounts) {
  const rebuilt = preparePlainReview(plan.intent, plan.observed)
  check(isDeepStrictEqual(rebuilt, plan), 'Plan changed')
  const config = decodeLaunchConfig(Buffer.from(plan.observed.launchConfigBase64, 'base64'))
  const programs = PRODUCTION_PROGRAMS, a = plan.addresses, i = plan.intent
  const read = (role, owner, address, decode) => {
    const account = accounts[role]
    check(account?.address === address && account.owner === owner.toBase58() && account.executable === false, 'Postcondition account identity differs')
    const bytes = Buffer.from(account.dataBase64, 'base64')
    const size = role === 'launch' ? 565 : role === 'pool' ? 411 : role === 'mint' || role === 'lpMint' ? 519 : 204
    check(bytes.length === size && bytes.toString('base64') === account.dataBase64 && bytes[8] === 1, 'Postcondition size/version differs')
    return decode(bytes)
  }
  const mint = read('mint', programs.token, i.mint, decodeMint)
  check(mint.name === i.name && mint.symbol === i.symbol && mint.uri === i.uri && mint.creator.toBase58() === i.creator
    && mint.decimals === config.decimals && mint.supply === config.supply && mint.maxSupply === config.supply
    && !mint.mintAuthority && !mint.metadataAuthority && !mint.freezeAuthority && !mint.hookAuthority && !mint.hookProgram && mint.hookFlags === 0, 'Mint postconditions differ')
  const curve = config.supply * BigInt(config.curveBps) / 10000n, reserve = config.supply - curve
  const virtualBase = curve * reserve / (curve - reserve), graduationQuote = BigInt(i.virtualQuote) * (curve - reserve) / reserve
  const launch = read('launch', programs.launch, a.launch, decodeLaunch), pool = read('pool', programs.swap, a.pool, decodePool)
  check(launch.creator.toBase58() === i.creator && launch.mint.toBase58() === i.mint && launch.pool.toBase58() === a.pool
    && launch.creatorFeeBps === 0 && launch.modules === 0 && !launch.customHook && launch.customHookFlags === 0
    && isDeepStrictEqual(launch.rules, { ...NO_LAUNCH_RULES }) && launch.status === 0 && !launch.creatorBought
    && launch.config.equals(PublicKey.default) && launch.quoteMint.equals(programs.quoteMint)
    && launch.lpFeeBps === config.lpFeeBps && launch.sniperWindowSecs === config.sniperWindowSecs && launch.sniperStartBps === config.sniperStartBps
    && launch.reserveHolding.toBase58() === a.launchReserve && launch.quoteHolding.toBase58() === a.launchQuote && launch.lpHolding.toBase58() === a.launchLp
    && launch.virtualBase === virtualBase && launch.graduationQuote === graduationQuote
    && launch.virtualQuote === BigInt(i.virtualQuote) && launch.curveTokens === curve && launch.reserveTokens === reserve, 'Launch postconditions differ')
  const swap = decodeSwapConfig(Buffer.from(plan.observed.swapConfigBase64, 'base64'))
  check(pool.curve && pool.creator.toBase58() === a.launch && pool.baseMint.toBase58() === i.mint
    && pool.quoteMint.equals(PRODUCTION_PROGRAMS.quoteMint) && pool.hookProgram?.equals(programs.launch)
    && pool.hookFlags === 1985 && pool.lpFeeBps === config.lpFeeBps && pool.feeModel === 1 && pool.protocolFeeBps === 0
    && pool.protocolShareBps === swap.launchProtocolShareBps && pool.lpMint.toBase58() === a.lpMint
    && pool.baseVault.toBase58() === a.baseVault && pool.quoteVault.toBase58() === a.quoteVault
    && pool.virtualBase === virtualBase && pool.virtualQuote === BigInt(i.virtualQuote)
    && pool.baseReserve === curve && pool.quoteReserve === 0n && pool.lpSupply === 0n && pool.swapCount === 0n, 'Pool postconditions differ')
  for (const [role, address, mintAddress, owner, amount] of [
    ['launchReserve', a.launchReserve, i.mint, a.launch, reserve], ['launchQuote', a.launchQuote, programs.quoteMint.toBase58(), a.launch, 0n],
    ['baseVault', a.baseVault, i.mint, a.pool, curve], ['quoteVault', a.quoteVault, programs.quoteMint.toBase58(), a.pool, 0n],
    ['launchLp', a.launchLp, a.lpMint, a.launch, 0n],
  ]) {
    const h = read(role, programs.token, address, decodeHolding)
    check(h.mint.toBase58() === mintAddress && h.owner.toBase58() === owner && h.amount === amount && !h.frozen && !h.delegate
      && h.delegatedAmount === 0n && h.hookData.every(b => b === 0), 'Holding postconditions differ')
  }
  const lp = read('lpMint', programs.token, a.lpMint, decodeMint)
  check(lp.supply === 0n && lp.maxSupply === 0n && lp.mintAuthority?.toBase58() === a.pool && !lp.hookProgram
    && !lp.freezeAuthority && !lp.metadataAuthority && !lp.hookAuthority && lp.hookFlags === 0, 'LP postconditions differ')
  // These are unused ABI placeholders in plain pools, not deployed Kit support.
  const kit = PublicKey.findProgramAddressSync([Buffer.from('kit'), pk(i.mint).toBuffer()], pk('AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'))[0]
  const holder = PublicKey.findProgramAddressSync([Buffer.from('holding'), programs.quoteMint.toBuffer(), kit.toBuffer()], programs.token)[0]
  check(launch.kitConfig.equals(kit) && launch.holderVault.equals(holder), 'ABI placeholder differs')
  const literal = s => ({ kind: 'literal', bytes: Buffer.from(s) }), at = index => ({ kind: 'account', index })
  const registry = encodeHookAccountList({ version: 1, accounts: [
    { writable: true, source: { kind: 'pda', program: programs.launch, seeds: [literal('launch'), at(2)] } },
    { writable: true, source: { kind: 'pda', program: programs.token, seeds: [literal('holding'), at(3), at(5)] } },
    { writable: true, source: { kind: 'key', key: holder } }, { writable: false, source: { kind: 'key', key: kit } },
  ] })
  check(accounts.poolRegistry?.address === a.poolRegistry && accounts.poolRegistry.owner === programs.launch.toBase58()
    && accounts.poolRegistry.executable === false && accounts.poolRegistry.dataBase64 === registry.toString('base64'), 'Registry differs')
  return { status: 'plain-state-matched', curveTokens: String(curve), reserveTokens: String(reserve), quoteReserve: '0', lpSupply: '0', canSubmit: false }
}
