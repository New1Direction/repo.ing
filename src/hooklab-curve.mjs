// Frozen production-source candidate, NOT an accepted or activated trading adapter.
// No generic SDK builders, native SOL wrapping, holding creation, signing or broadcast.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { z } from 'zod'
import { PRODUCTION_PROGRAMS as P, productionCandidateManifest, mainnetLaunchAddresses,
  decodePool, decodeLaunch, decodeHolding, decodeMint, decodeSwapConfig, encodeHookAccountList, NO_LAUNCH_RULES } from '@repo-ing/hooklab-production-candidate'
import { inspectHookLabMessage, checkHookLabReviewFreshness, checkHookLabSimulation } from './hooklab-message-boundary.mjs'

export const CURVE_SOURCE = 'f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32'
export const CURVE_PROFILE = '9df8e9ceaa3a73fb37c8af35254382f27e38bfc35d6a1fcfa4b72223e75e9cb7'
export const curveDigest = value => createHash('sha256').update(value).digest('hex')
const check = (ok, message) => { if (!ok) throw new Error(message) }
const pk = value => new PublicKey(value)
const key = z.string().max(44).refine(v => { try { return pk(v).toBase58() === v } catch { return false } })
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const u64 = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn)
const positive = u64.refine(v => BigInt(v) > 0n)
const derive = (program, seed, ...keys) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map(k => pk(k).toBuffer())], program)[0]
const holding = (mint, owner) => derive(P.token, 'holding', mint, owner)
const event = program => derive(program, '__event_authority')
const plainKey = 'AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'
const account = z.object({ address: key, owner: key, executable: z.literal(false), dataBase64: z.string().max(4096) }).strict()
const accountsSchema = z.object({ swapConfig: account, pool: account, launch: account, mint: account,
  quoteMint: account, baseVault: account, quoteVault: account, traderBase: account, traderQuote: account,
  launchQuote: account, poolRegistry: account }).strict()
const intentSchema = z.object({ schema: z.literal('repoing/curve-intent/1'), side: z.enum(['buy', 'sell']),
  trader: key, recipient: key, feePayer: key, mint: key, amountIn: positive, minAmountOut: positive,
  maxInput: positive, maxPriceImpactBps: integer.max(1000), maxNetworkFeeLamports: u64,
  computeUnitLimit: integer.positive().max(1400000), computeUnitPriceMicroLamports: u64 }).strict()
const stateSchema = z.object({ schema: z.literal('repoing/curve-snapshot/1'), genesisHash: key,
  slot: integer, nowMs: integer, blockhash: key, lastValidBlockHeight: integer,
  networkFeeLamports: u64, accounts: accountsSchema }).strict()

/** Local artifact integrity only. A checksum is not Sigstore provenance or deployment acceptance. */
export function inspectCurveArtifacts() {
  // Check the package actually imported, which npm may copy rather than symlink to vendor.
  const root = new URL('../', import.meta.resolve('@repo-ing/hooklab-production-candidate'))
  const manifest = productionCandidateManifest()
  check(curveDigest(readFileSync(new URL('integration/candidate.json', root))) === CURVE_PROFILE, 'Profile drift')
  check(curveDigest(readFileSync(new URL('dist/index.mjs', root))) === '36ec6bb65be729e52e7545fb23b152c4f202e028b246da3c2dd07dfd49fca77a', 'SDK drift')
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', root)))
  check(provenance.revision === CURVE_SOURCE && provenance.manifestSha256 === CURVE_PROFILE, 'Source binding drift')
  return { source: CURVE_SOURCE, profileSha256: CURVE_PROFILE, genesisHash: manifest.genesisHash,
    artifactIntegrityMatched: true, provenanceVerified: false, deploymentVerified: false }
}

export function curveAddresses(input) {
  const i = intentSchema.parse(input)
  // Deliberately only the zero-fee proposed first trial; other economics require a new contract.
  const a = mainnetLaunchAddresses(pk(i.mint), P.quoteMint, 0, P)
  const kitConfig = derive(pk(plainKey), 'kit', i.mint)
  return Object.fromEntries(Object.entries({ ...a, kitConfig, holderVault: holding(P.quoteMint, kitConfig),
    swapConfig: derive(P.swap, 'config'), mint: pk(i.mint), quoteMint: P.quoteMint,
    traderBase: holding(i.mint, i.side === 'buy' ? i.recipient : i.trader),
    traderQuote: holding(P.quoteMint, i.side === 'buy' ? i.trader : i.recipient),
  }).map(([name, value]) => [name, value.toBase58()]))
}

function read(accounts, role, address, owner, size, decode) {
  const a = accounts[role], bytes = Buffer.from(a.dataBase64, 'base64')
  check(a.address === address && a.owner === owner.toBase58() && !a.executable, `${role} identity differs`)
  check(bytes.length === size && bytes[8] === 1 && bytes.toString('base64') === a.dataBase64, `${role} layout differs`)
  return decode(bytes)
}

/** Restrictive, zero-fee, pre-existing-custom-holdings policy over UNTRUSTED supplied bytes. */
export function inspectCurveState(input, observation) {
  const intent = intentSchema.parse(input), state = stateSchema.parse(observation), a = curveAddresses(intent)
  const artifacts = inspectCurveArtifacts(), accounts = state.accounts
  check(state.genesisHash === artifacts.genesisHash, 'Network differs')
  check(intent.mint !== a.quoteMint, 'Identical mints')
  const config = read(accounts, 'swapConfig', a.swapConfig, P.swap, 189, decodeSwapConfig)
  const pool = read(accounts, 'pool', a.pool, P.swap, 411, decodePool)
  const launch = read(accounts, 'launch', a.launch, P.launch, 565, decodeLaunch)
  check(!config.paused, 'Trading paused')
  const roles = productionCandidateManifest().requestedRolesNotDeployed
  check(config.admin.toBase58() === roles.ownerAdmin && config.treasury.toBase58() === roles.treasuryAndCollector
    && config.feeCollector.equals(config.treasury), 'Config authorities differ')
  check(config.protocolFeeBps === 0 && config.launchProtocolShareBps === 0 && pool.lpFeeBps === 0
    && pool.protocolFeeBps === 0 && pool.protocolShareBps === 0 && pool.feeModel === 1, 'Nonzero fees or non-share pool unsupported')
  check(pool.curve && pool.lpSupply === 0n && pool.creator.toBase58() === a.launch && pool.hookProgram?.equals(P.launch)
    && pool.hookFlags === 1985 && pool.baseMint.toBase58() === intent.mint && pool.quoteMint.equals(P.quoteMint)
    && pool.baseVault.toBase58() === a.baseVault && pool.quoteVault.toBase58() === a.quoteVault
    && pool.lpMint.toBase58() === a.lpMint, 'Pool binding differs')
  check(launch.status === 0 && launch.mint.toBase58() === intent.mint && launch.pool.toBase58() === a.pool
    && launch.quoteMint.equals(P.quoteMint) && launch.quoteHolding.toBase58() === a.launchQuote
    && launch.reserveHolding.toBase58() === a.launchReserve && launch.lpHolding.toBase58() === a.launchLp
    && launch.kitConfig.toBase58() === a.kitConfig && launch.holderVault.toBase58() === a.holderVault
    && launch.virtualBase === pool.virtualBase && launch.virtualQuote === pool.virtualQuote, 'Launch binding differs')
  check(launch.creatorFeeBps === 0 && launch.lpFeeBps === 0 && launch.sniperStartBps === 0
    && launch.sniperWindowSecs === 0 && launch.modules === 0 && !launch.customHook && launch.customHookFlags === 0
    && launch.config.equals(PublicKey.default) && launch.authorShareBps === 0
    && isDeepStrictEqual(launch.rules, { ...NO_LAUNCH_RULES }), 'Nonplain or dynamic fee launch unsupported')
  for (const role of ['mint', 'quoteMint']) {
    const mint = read(accounts, role, a[role], P.token, 519, decodeMint)
    check(!mint.hookProgram && mint.hookFlags === 0 && !mint.freezeAuthority && !mint.hookAuthority, 'Mint hook/freeze unsupported')
    if (role === 'mint') check(!mint.mintAuthority && !mint.metadataAuthority, 'Mutable base mint unsupported')
  }
  const holdings = {}
  for (const [role, mint, owner] of [
    ['baseVault', intent.mint, a.pool], ['quoteVault', a.quoteMint, a.pool], ['launchQuote', a.quoteMint, a.launch],
    ['traderBase', intent.mint, intent.side === 'buy' ? intent.recipient : intent.trader],
    ['traderQuote', a.quoteMint, intent.side === 'buy' ? intent.trader : intent.recipient],
  ]) {
    const h = read(accounts, role, a[role], P.token, 204, decodeHolding)
    check(h.mint.toBase58() === mint && h.owner.toBase58() === owner && !h.frozen && !h.delegate
      && h.delegatedAmount === 0n && h.hookData.every(b => b === 0), `${role} holding differs`)
    holdings[role] = h.amount
  }
  check(new Set(Object.values(accounts).map(a => a.address)).size === Object.keys(accounts).length, 'Aliased accounts')
  check(holdings.baseVault === pool.baseReserve && holdings.quoteVault === pool.quoteReserve + pool.protocolFeesQuote, 'Vault/reserve mismatch')
  const literal = s => ({ kind: 'literal', bytes: Buffer.from(s) }), at = index => ({ kind: 'account', index })
  const registry = encodeHookAccountList({ version: 1, accounts: [
    { writable: true, source: { kind: 'pda', program: P.launch, seeds: [literal('launch'), at(2)] } },
    { writable: true, source: { kind: 'pda', program: P.token, seeds: [literal('holding'), at(3), at(5)] } },
    { writable: true, source: { kind: 'key', key: pk(a.holderVault) } },
    { writable: false, source: { kind: 'key', key: pk(a.kitConfig) } },
  ] })
  check(accounts.poolRegistry.address === a.poolRegistry && accounts.poolRegistry.owner === P.launch.toBase58()
    && accounts.poolRegistry.dataBase64 === registry.toString('base64'), 'Pool registry differs')
  const amount = BigInt(intent.amountIn), buy = intent.side === 'buy'
  check(amount <= BigInt(intent.maxInput) && amount <= holdings[buy ? 'traderQuote' : 'traderBase'], 'Input exceeds cap or holding')
  const x = buy ? pool.quoteReserve + pool.virtualQuote : pool.baseReserve + pool.virtualBase
  const y = buy ? pool.baseReserve + pool.virtualBase : pool.quoteReserve + pool.virtualQuote
  check(x > 0n && y > 0n && amount * y <= (1n << 128n) - 1n, 'Curve overflow or empty liquidity')
  const output = amount * y / (x + amount)
  check(output > 0n && output <= (buy ? pool.baseReserve : pool.quoteReserve), 'Insufficient real liquidity')
  check(output >= BigInt(intent.minAmountOut), 'Minimum output not met')
  // Round up, so a limit just below the boundary cannot pass by truncation.
  const impact = (amount * 10000n + x + amount - 1n) / (x + amount)
  check(impact <= BigInt(intent.maxPriceImpactBps), 'Price impact limit')
  const after = { baseReserve: buy ? pool.baseReserve - output : pool.baseReserve + amount,
    quoteReserve: buy ? pool.quoteReserve + amount : pool.quoteReserve - output,
    traderBase: buy ? holdings.traderBase + output : holdings.traderBase - amount,
    traderQuote: buy ? holdings.traderQuote - amount : holdings.traderQuote + output, swapCount: pool.swapCount + 1n }
  check([...Object.values(after), after.quoteReserve + pool.protocolFeesQuote].every(v => v >= 0n && v <= 0xffffffffffffffffn), 'Post-trade u64 overflow')
  check(pool.baseVolume + (buy ? output : amount) <= (1n << 128n) - 1n
    && pool.quoteVolume + (buy ? amount : output) <= (1n << 128n) - 1n, 'Post-trade volume overflow')
  check(buy ? after.quoteReserve < launch.graduationQuote : pool.quoteReserve < launch.graduationQuote, 'Graduation boundary unsupported')
  return { intent, state, addresses: a, pool, launch, holdings, output, after, artifacts }
}

/** Canonical source ABI: swap.rs SwapArgs; client.rs swap account order. No ID remapping. */
export function buildCurveInstruction(input, observation) {
  const { intent: i, addresses: a } = inspectCurveState(input, observation)
  const data = Buffer.alloc(31)
  Buffer.from('f8c69e91e17587c8', 'hex').copy(data)
  data[8] = i.side === 'buy' ? 1 : 0
  data.writeBigUInt64LE(BigInt(i.amountIn), 9); data.writeBigUInt64LE(BigInt(i.minAmountOut), 17)
  const addresses = [i.trader, a.swapConfig, a.pool, i.mint, a.quoteMint, a.baseVault, a.quoteVault,
    a.traderBase, a.traderQuote, P.launch, derive(P.swap, 'hook-authority', P.launch), P.token,
    event(P.token), event(P.swap), P.swap, a.launch, a.launchQuote, a.holderVault, a.kitConfig]
  return new TransactionInstruction({ programId: P.swap, data, keys: addresses.map((address, n) => ({
    pubkey: pk(address), isSigner: n === 0, isWritable: [2, 5, 6, 7, 8, 15, 16, 17].includes(n),
  })) })
}

export function prepareCurveReview(input, observation) {
  const checked = inspectCurveState(input, observation), { intent: i, state: s } = checked
  const ix = buildCurveInstruction(i, s)
  // No ALT dependency or caller-provided instructions in this bounded candidate.
  const message = new TransactionMessage({ payerKey: pk(i.feePayer), recentBlockhash: s.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: i.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(i.computeUnitPriceMicroLamports) }), ix,
  ] }).compileToV0Message()
  const priority = (BigInt(i.computeUnitLimit) * BigInt(i.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(BigInt(s.networkFeeLamports) >= priority, 'Invalid network fee quote')
  const review = { schema: 'hooklab-message-review/1', operation: `curve-${i.side}`, genesisHash: s.genesisHash,
    profileSha256: CURVE_PROFILE, policySha256: curveDigest(JSON.stringify(s)), intentSha256: curveDigest(JSON.stringify(i)),
    payer: i.feePayer, wallet: i.trader, messageBase64: Buffer.from(message.serialize()).toString('base64'),
    messageSha256: curveDigest(message.serialize()), requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58()),
    accounts: message.staticAccountKeys.map((k, n) => ({ address: k.toBase58(), signer: message.isAccountSigner(n), writable: message.isAccountWritable(n) })),
    lookupTables: [], observedSlot: s.slot, validUntilSlot: s.slot + 32, observedAtMs: s.nowMs,
    reviewExpiresAtMs: s.nowMs + 15000, lastValidBlockHeight: s.lastValidBlockHeight,
    baseFeeLamports: String(BigInt(s.networkFeeLamports) - priority), maxFeeLamports: i.maxNetworkFeeLamports,
    instructionDebitLamports: '0', maxNativeDebitLamports: i.maxNetworkFeeLamports }
  inspectHookLabMessage(review)
  return { intent: i, observed: s, review, addresses: checked.addresses, candidateOutput: String(checked.output),
    source: CURVE_SOURCE, artifactIntegrityMatched: true, provenanceVerified: false, policyAccepted: false,
    onChainDeadline: false, onChainEconomicsGuard: false, canSign: false, canSubmit: false }
}

export function verifyCurvePlan(plan) {
  check(isDeepStrictEqual(prepareCurveReview(plan.intent, plan.observed), plan), 'Curve plan changed')
  return plan
}

/** Recovery accepts already externally produced signatures, never generates or prompts for one. */
export function mergeCurveSignatures(plan, retainedBase64, incomingBase64) {
  verifyCurvePlan(plan)
  const load = value => {
    check(typeof value === 'string' && value.length <= 1644, 'Invalid partial wire')
    const wire = Buffer.from(value, 'base64'), tx = VersionedTransaction.deserialize(wire)
    check(wire.length <= 1232 && wire.toString('base64') === value && Buffer.from(tx.serialize()).equals(wire)
      && Buffer.from(tx.message.serialize()).toString('base64') === plan.review.messageBase64, 'Partial message changed')
    check(tx.signatures.length === plan.review.requiredSigners.length, 'Signer count differs')
    for (const [n, signature] of tx.signatures.entries()) {
      if (signature.every(b => b === 0)) continue
      const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk(plan.review.requiredSigners[n]).toBuffer()]), format: 'der', type: 'spki' })
      check(verify(null, tx.message.serialize(), publicKey, signature), 'Invalid external signature')
    }
    return tx
  }
  const incoming = load(incomingBase64), retained = retainedBase64 ? load(retainedBase64) : new VersionedTransaction(incoming.message)
  for (let n = 0; n < incoming.signatures.length; n++) {
    if (incoming.signatures[n].every(b => b === 0)) continue
    check(retained.signatures[n].every(b => b === 0) || Buffer.from(retained.signatures[n]).equals(Buffer.from(incoming.signatures[n])), 'Conflicting external signature')
    retained.signatures[n] = incoming.signatures[n]
  }
  const present = retained.signatures.map((s, n) => s.some(b => b !== 0) ? plan.review.requiredSigners[n] : null).filter(Boolean)
  check(present.length > 0, 'No external signature supplied')
  return { transactionBase64: Buffer.from(retained.serialize()).toString('base64'), present,
    complete: present.length === retained.signatures.length, canSubmit: false }
}

export async function simulateCurveReview(connection, plan, current) {
  verifyCurvePlan(plan); checkHookLabReviewFreshness(plan.review, current)
  check(await connection.getGenesisHash() === plan.review.genesisHash, 'Wrong RPC network')
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64')))
  const simulation = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false,
    commitment: 'finalized', minContextSlot: plan.review.observedSlot })
  return checkHookLabSimulation(plan.review, current, { ...simulation, messageSha256: plan.review.messageSha256 })
}

// No caller/env switch can convert source parity or an offline plan into live acceptance.
export async function submitCurveTransaction() {
  throw Object.assign(new Error('Curve execution requires separately accepted production policy and exact owner approval'), { status: 423, code: 'CURVE_EXECUTION_DISABLED' })
}
