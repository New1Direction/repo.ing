// Isolated devnet acceptance boundary. No active pins, signer, submission or fallback.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { z } from 'zod'
import { FRESH_DEVNET, freshCandidateManifest, freshPlainLaunch, freshRentInventory,
  launchV2Budget, launchEconomicsHash, poolEconomicsHash, decodeLaunchConfig, decodeSwapConfig, decodeMint,
  decodeLaunch, decodePool, decodeHolding, NO_LAUNCH_RULES } from '@repo-ing/hooklab-guarded-candidate'

export const FRESH_MANIFEST_SHA256 = '1a0ee482d83587f80af790729733e662ce39096e078b5a18c4e5c7514d7682d4'
export const FRESH_SOURCE_COMMIT = 'f3c57ccc15f327a65f447f51b6f4b61833de78b7'
export const HLTEST_CREATOR = 'DBr3Qxa5LgkJCRZb7uwXwmBau36kzgFrnXgu5vNhux7B'
export const HLTEST_MINT = '89oRwzQmrYCL3r6eCwo6Rk6h52S5ajxjan9gRgx6MbWR'
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const altOwner = 'AddressLookupTab1e1111111111111111111111111'
const sha = data => createHash('sha256').update(data).digest('hex')
const key = address => new PublicKey(address)
const json = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
const requireMatch = (ok, message) => { if (!ok) throw new Error(message) }
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) <= 0xffffffffffffffffn)
const deploymentProgram = z.object({ deploySlot: integer.positive(), configSha256: hash }).strict()
const deploymentSchema = z.object({
  schema: z.literal('repoing/fresh-plain-deployment/1'), sourceCommit: z.literal(FRESH_SOURCE_COMMIT),
  manifestSha256: z.literal(FRESH_MANIFEST_SHA256), finalizedSlot: integer.positive(),
  swap: deploymentProgram, launch: deploymentProgram,
}).strict()

/** One finalized bank for programs, configs, quote, ALT, creator and every creation address.
 * Evidence is an operator-reviewed producer observation, never an authorization token.
 * Matching code is still upgradeable; hashes are not bound by the native creation guard.
 */
export async function inspectFreshPlain(connection, { confirmedNetwork, deployment } = {}) {
  requireMatch(confirmedNetwork === 'devnet', 'Explicit devnet confirmation required')
  const manifest = freshCandidateManifest()
  const out = { network: 'devnet', sourceCommit: FRESH_SOURCE_COMMIT, manifestSha256: FRESH_MANIFEST_SHA256, observedSlot: null,
    programs: [], configs: {}, accounts: {}, refusals: [], readyForUnsignedSimulation: false,
    canSign: false, canSubmit: false }
  const refuse = (subject, reason) => out.refusals.push({ subject, reason })
  const parsed = deploymentSchema.safeParse(deployment)
  if (!parsed.success) refuse('deployment', 'Finalized producer deployment/config evidence is required; candidate files alone do not establish deployment.')
  try {
    if (await connection.getGenesisHash() !== manifest.genesisHash) {
      refuse('network', 'RPC genesis is not Solana devnet'); return out
    }
    // Token executes in the nested CPI. Bridge/Kit remain identity-only dependencies;
    // no bridge/Kit instruction is built or allowed in the acceptance message.
    const programs = [...manifest.programs, ...manifest.dependencies]
    const inventory = freshRentInventory(key(HLTEST_MINT), key(manifest.quoteMint.address), 30)
    const addresses = [...programs.flatMap(p => [p.programId, p.programData]), ...Object.values(manifest.configs),
      manifest.quoteMint.address, manifest.alt.address, HLTEST_CREATOR, ...inventory.map(a => a.address.toBase58())]
    const snapshot = await connection.getMultipleAccountsInfoAndContext(addresses.map(key), {
      commitment: 'finalized', ...(parsed.success ? { minContextSlot: parsed.data.finalizedSlot } : {}),
    })
    requireMatch(snapshot.value.length === addresses.length && Number.isSafeInteger(snapshot.context.slot), 'Incomplete account snapshot')
    out.observedSlot = snapshot.context.slot
    if (parsed.success) requireMatch(out.observedSlot >= parsed.data.finalizedSlot, 'Snapshot predates deployment evidence')
    const accounts = new Map(addresses.map((address, i) => [address, snapshot.value[i]]))
    for (const p of programs) {
      try {
        const program = accounts.get(p.programId), pd = accounts.get(p.programData)
        requireMatch(program?.executable && program.owner.toBase58() === loader && program.data.length === 36
          && program.data.readUInt32LE(0) === 2 && key(program.data.subarray(4)).toBase58() === p.programData, 'Program loader or ProgramData mismatch')
        requireMatch(pd && !pd.executable && pd.owner.toBase58() === loader && pd.data.length > 45
          && pd.data.readUInt32LE(0) === 3 && pd.data[12] === 1, 'Invalid ProgramData')
        const authority = key(pd.data.subarray(13, 45)).toBase58(), slot = pd.data.readBigUInt64LE(4)
        requireMatch(authority === (p.authority ?? p.upgradeAuthority), 'Upgrade authority mismatch')
        const code = pd.data.subarray(45)
        requireMatch(code.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'Missing ELF header')
        let end = code.length
        while (end > 0 && code[end - 1] === 0) end--
        const normalizedHash = sha(code.subarray(0, end))
        requireMatch(normalizedHash === (p.normalizedSha256 ?? p.binaryHash), 'Executable hash mismatch')
        if (p.capacityBytes) requireMatch(code.length === p.capacityBytes && sha(code) === p.fileSha256, 'Exact fresh ELF differs')
        const expectedSlot = p.deploySlot ?? (parsed.success ? parsed.data[p.role]?.deploySlot : null)
        if (expectedSlot != null) requireMatch(slot === BigInt(expectedSlot) && slot <= BigInt(out.observedSlot), 'Deploy slot mismatch')
        out.programs.push({ role: p.role, address: p.programId, programData: p.programData,
          deploySlot: slot.toString(), authority, normalizedHash, matched: true })
      } catch (error) { refuse(p.role, error.message) }
    }
    const owned = (address, owner) => {
      const account = accounts.get(address)
      requireMatch(account && !account.executable && account.owner.toBase58() === owner, 'Missing or wrongly owned account')
      return account
    }
    for (const role of ['swap', 'launch']) {
      try {
        const data = owned(manifest.configs[role], FRESH_DEVNET[role].toBase58()).data
        requireMatch(data.length === (role === 'swap' ? 189 : 250) && data[8] === 1, 'Config length/version mismatch')
        const decoded = role === 'swap' ? decodeSwapConfig(data) : decodeLaunchConfig(data)
        requireMatch(!decoded.paused && decoded.admin.equals(FRESH_DEVNET.authority) && decoded.treasury.equals(FRESH_DEVNET.authority), 'Config paused or authority/treasury mismatch')
        if (role === 'swap') requireMatch(decoded.feeCollector.equals(FRESH_DEVNET.authority), 'Fee collector mismatch')
        else requireMatch(decoded.quoteMint.toBase58() === manifest.quoteMint.address, 'Quote mint mismatch')
        // Always pass fresh program AND config; SDK defaults are legacy identities.
        const economics = role === 'swap' ? poolEconomicsHash(decoded, 1, key(manifest.configs.swap), FRESH_DEVNET.swap)
          : launchEconomicsHash(decoded, 1, key(HLTEST_CREATOR), null, key(manifest.configs.launch), FRESH_DEVNET.launch)
        requireMatch(economics.toString('hex') === manifest.acceptanceEconomics[role === 'swap' ? 'poolHash' : 'launchHash'], 'Config economics mismatch')
        const dataSha256 = sha(data)
        if (parsed.success) requireMatch(dataSha256 === parsed.data[role].configSha256, 'Config changed since producer verification')
        requireMatch((role === 'swap' ? decoded.poolsCreated : decoded.launches) === 0n, 'Acceptance requires unused configs')
        out.configs[role] = { address: manifest.configs[role], dataSha256, economicsHash: economics.toString('hex'), decoded: json(decoded) }
      } catch (error) { refuse(`${role}Config`, error.message) }
    }
    try {
      const data = owned(manifest.quoteMint.address, manifest.quoteMint.owner).data
      requireMatch(sha(data) === manifest.quoteMint.dataSha256, 'Quote mint bytes changed')
      const mint = decodeMint(data)
      requireMatch(mint.version === 1 && mint.decimals === 9 && mint.hookProgram === null && mint.hookFlags === 0 && mint.freezeAuthority === null, 'Unsupported quote mint')
      out.accounts.quoteMint = { address: manifest.quoteMint.address, dataSha256: sha(data) }
    } catch (error) { refuse('quoteMint', error.message) }
    try {
      const data = owned(manifest.alt.address, altOwner).data
      requireMatch(sha(data) === manifest.alt.dataSha256, 'ALT changed')
      const alt = AddressLookupTableAccount.deserialize(data)
      requireMatch(alt.deactivationSlot === 0xffffffffffffffffn && alt.lastExtendedSlot < out.observedSlot
        && isDeepStrictEqual(alt.addresses.map(a => a.toBase58()), manifest.alt.addresses), 'ALT inactive or inconsistent')
      out.accounts.alt = { address: manifest.alt.address, dataSha256: sha(data) }
    } catch (error) { refuse('alt', error.message) }
    for (const account of inventory) {
      if (accounts.get(account.address.toBase58()) != null) refuse(account.role, 'Creation account already exists. Recover this mint; never relaunch with a new key.')
    }
    const creator = accounts.get(HLTEST_CREATOR)
    if (creator && (creator.executable || creator.owner.toBase58() !== '11111111111111111111111111111111' || creator.data.length)) refuse('creator', 'Creator must be a system wallet')
    out.accounts.creator = { address: HLTEST_CREATOR, lamports: String(creator?.lamports ?? 0) }
  } catch {
    // RPC errors can contain credential-bearing URLs. Never copy them into telemetry or output.
    refuse('rpc', 'Finalized snapshot unavailable or inconsistent; no readiness inferred')
  }
  out.readyForUnsignedSimulation = out.refusals.length === 0
  return out
}

/** Reconstruct the producer's plain HLTEST message, byte for byte, without RPC or secrets.
 * This deliberately returns no signing/send operation and never upgrades preview into approval.
 */
export function verifyFreshHltestPreview(input, { confirmedNetwork } = {}) {
  requireMatch(confirmedNetwork === 'devnet', 'Explicit devnet confirmation required')
  const manifest = freshCandidateManifest()
  const args = { name: 'Hook Lab Devnet Acceptance', symbol: 'HLTEST', uri: '', creatorFeeBps: 0,
    virtualQuote: '1000000000', rules: { ...NO_LAUNCH_RULES } }
  requireMatch(input.creator === HLTEST_CREATOR && input.mint === HLTEST_MINT, 'Acceptance signer identity mismatch')
  requireMatch(isDeepStrictEqual(input.args, args), 'Only exact plain HLTEST recipe is supported')
  integer.parse(input.observedSlot); integer.parse(input.lastValidBlockHeight); key(input.blockhash)
  const guard = z.object({ version: z.literal(2), deadlineSlot: decimal,
    expectedLaunchEconomicsHash: z.literal(manifest.acceptanceEconomics.launchHash),
    expectedPoolEconomicsHash: z.literal(manifest.acceptanceEconomics.poolHash),
    maxLaunchFeeLamports: z.literal('10000000'), maxPoolCreationFeeLamports: z.literal('0'),
    maxRentLamports: z.literal('22860000'), maxTotalDebitLamports: z.literal('32860000'),
  }).strict().parse(input.guard)
  requireMatch(BigInt(guard.deadlineSlot) > BigInt(input.observedSlot)
    && BigInt(guard.deadlineSlot) <= BigInt(input.observedSlot) + 1500n, 'Deadline outside approved window')
  const inventory = freshRentInventory(key(HLTEST_MINT), key(manifest.quoteMint.address), 30)
  const rents = z.array(z.object({ role: z.string(), address: z.string(), bytes: integer, rentLamports: decimal }).strict()).parse(input.accountsAndRents)
  requireMatch(isDeepStrictEqual(rents.map(({ rentLamports, ...a }) => a), inventory.map(a => ({ ...a, address: a.address.toBase58() }))), 'Rent inventory mismatch')
  const rentBySize = new Map()
  for (const account of rents) {
    const rent = BigInt(account.rentLamports)
    requireMatch(rent > 0n && (!rentBySize.has(account.bytes) || rentBySize.get(account.bytes) === rent), 'Invalid or inconsistent rent')
    rentBySize.set(account.bytes, rent)
  }
  requireMatch(isDeepStrictEqual(input.reusedAlt, { address: manifest.alt.address, dataSha256: manifest.alt.dataSha256, addresses: manifest.alt.addresses }), 'ALT proposal mismatch')
  requireMatch(input.newAltCostLamports === 0 && input.bridgeDepositLamports === 0, 'No ALT setup or bridge deposit allowed')
  const budget = launchV2Budget(inventory, rentBySize, 10000000n, 0n, 10000n)
  requireMatch(isDeepStrictEqual(input.budget, { rentLamports: budget.rentLamports.toString(),
    instructionDebitLamports: budget.instructionDebitLamports.toString(), allInLamports: Number(budget.allInLamports),
    networkFeeLamports: 10000, priorityFeeLamports: 0 }) && budget.allInLamports === 32870000n, 'Acceptance budget mismatch')
  const ix = freshPlainLaunch(key(HLTEST_CREATOR), key(HLTEST_MINT), FRESH_DEVNET.authority, key(manifest.quoteMint.address), 30,
    { ...args, virtualQuote: BigInt(args.virtualQuote) }, { ...guard,
      deadlineSlot: BigInt(guard.deadlineSlot), expectedLaunchEconomicsHash: Buffer.from(guard.expectedLaunchEconomicsHash, 'hex'),
      expectedPoolEconomicsHash: Buffer.from(guard.expectedPoolEconomicsHash, 'hex'), maxLaunchFeeLamports: 10000000n,
      maxPoolCreationFeeLamports: 0n, maxRentLamports: 22860000n, maxTotalDebitLamports: 32860000n })
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }), ix]
  const alt = new AddressLookupTableAccount({ key: key(manifest.alt.address), state: { deactivationSlot: 0xffffffffffffffffn,
    lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: manifest.alt.addresses.map(key) } })
  const message = new TransactionMessage({ payerKey: key(HLTEST_CREATOR), recentBlockhash: input.blockhash, instructions }).compileToV0Message([alt])
  const bytes = Buffer.from(message.serialize())
  requireMatch(bytes.toString('base64') === input.preview.messageBase64 && sha(bytes) === input.preview.messageSha256, 'Unsigned message bytes differ from reconstruction')
  requireMatch(isDeepStrictEqual(input.preview.instructions, instructions.map(ix => ({ programId: ix.programId.toBase58(),
    keys: ix.keys.map(k => ({ address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), dataHex: ix.data.toString('hex') }))), 'Decoded instruction display differs from bytes')
  requireMatch(new VersionedTransaction(message).serialize().length === input.preview.wireBytes && input.preview.wireBytes === 1112
    && message.header.numRequiredSignatures === 2 && input.preview.signaturesRequired === 2, 'Wire size or signer count mismatch')
  return { schema: 'repoing/fresh-plain-preview-verification/1', network: 'devnet', manifestSha256: FRESH_MANIFEST_SHA256,
    sourceCommit: FRESH_SOURCE_COMMIT, messageSha256: sha(bytes), wireBytes: 1112, creator: HLTEST_CREATOR, mint: HLTEST_MINT,
    identities: { swap: FRESH_DEVNET.swap.toBase58(), launch: FRESH_DEVNET.launch.toBase58(), treasury: manifest.authority,
      token: manifest.quoteMint.owner, quoteMint: manifest.quoteMint.address, lookupTable: manifest.alt.address },
    budget: input.budget, canSign: false, canSubmit: false, message }
}

/** Read-only rehearsal against the exact blockhash/message; never replace it or sign it.
 * Re-run with a newly reviewed producer preview on expiry, fee/rent drift or state changes.
 */
export async function simulateFreshHltest(connection, input, options) {
  const { message, ...verification } = verifyFreshHltestPreview(input, options)
  const inspection = await inspectFreshPlain(connection, options)
  requireMatch(inspection.readyForUnsignedSimulation, 'Fresh deployment inspection refused; inspect before simulation')
  const current = inspection.observedSlot
  requireMatch(input.observedSlot <= current && current - input.observedSlot <= 32
    && BigInt(current) < BigInt(input.guard.deadlineSlot), 'Preview is stale or from the future; refresh and review')
  const blockhash = await connection.isBlockhashValid(input.blockhash, { commitment: 'finalized', minContextSlot: current })
  requireMatch(blockhash.value && await connection.getBlockHeight('finalized') <= input.lastValidBlockHeight, 'Blockhash expired; refresh and review')
  const fee = await connection.getFeeForMessage(message, 'finalized')
  requireMatch(fee.context.slot >= current && fee.value === input.budget.networkFeeLamports, 'Exact message network fee changed or unavailable')
  const checkedSizes = new Set()
  for (const account of input.accountsAndRents) {
    if (checkedSizes.has(account.bytes)) continue
    const rent = await connection.getMinimumBalanceForRentExemption(account.bytes, 'finalized')
    requireMatch(Number.isSafeInteger(rent) && BigInt(rent) === BigInt(account.rentLamports), 'Rent changed; refresh and review')
    checkedSizes.add(account.bytes)
  }
  requireMatch(BigInt(inspection.accounts.creator.lamports) >= BigInt(input.budget.allInLamports), 'Creator has insufficient devnet SOL')
  const simulation = await connection.simulateTransaction(new VersionedTransaction(message), {
    commitment: 'finalized', minContextSlot: current, sigVerify: false, replaceRecentBlockhash: false,
    accounts: { encoding: 'base64', addresses: [HLTEST_CREATOR, FRESH_DEVNET.authority.toBase58(), ...input.accountsAndRents.map(a => a.address)] },
  })
  const endSlot = await connection.getSlot('finalized')
  requireMatch(simulation.context.slot >= current && endSlot >= simulation.context.slot
    && endSlot - input.observedSlot <= 32 && BigInt(endSlot) < BigInt(input.guard.deadlineSlot), 'Simulation result expired; refresh and review')
  return { ...verification, inspection, simulation, checkedSlot: endSlot,
    status: simulation.value.err === null ? 'simulated' : 'simulation-failed',
    warning: 'Unsigned simulation is not signature verification, execution approval or finalized acceptance. Programs remain upgradeable.' }
}

/** Recover the SAME mint after reload or an ambiguous submission. No retry/new mint action.
 * A matching finalized receipt plus custom-token state is required; SPL balances are irrelevant.
 */
export async function recoverFreshHltest(connection, input, signature, options) {
  const { message, ...verification } = verifyFreshHltestPreview(input, options)
  requireMatch(typeof signature === 'string' && signature.length <= 88 && bs58.decode(signature).length === 64, 'Invalid transaction signature')
  const manifest = freshCandidateManifest()
  requireMatch(await connection.getGenesisHash() === manifest.genesisHash, 'RPC genesis is not Solana devnet')
  const receipt = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (!receipt) return { ...verification, signature, status: 'unresolved',
    warning: 'No finalized receipt yet. Preserve signed bytes and mint; reconcile before any retry.' }
  requireMatch(receipt.meta?.err === null && receipt.transaction.signatures[0] === signature, 'Receipt failed or signature differs')
  requireMatch(sha(receipt.transaction.message.serialize()) === verification.messageSha256, 'Finalized message differs from reviewed message')
  const accountKeys = message.getAccountKeys({ accountKeysFromLookups: receipt.meta.loadedAddresses })
  const indexOf = address => {
    for (let i = 0; i < accountKeys.length; i++) if (accountKeys.get(i).toBase58() === address) return i
    throw new Error('Receipt missing required account')
  }
  const balances = receipt.meta
  const delta = address => {
    const i = indexOf(address), before = balances.preBalances[i], after = balances.postBalances[i]
    requireMatch(Number.isSafeInteger(before) && Number.isSafeInteger(after), 'Unsafe receipt balance')
    return BigInt(after) - BigInt(before)
  }
  requireMatch(receipt.meta.fee === 10000 && delta(HLTEST_CREATOR) === -32870000n
    && delta(FRESH_DEVNET.authority.toBase58()) === 10000000n, 'Receipt debit, fee or treasury credit differs from approval')
  for (const account of input.accountsAndRents) {
    requireMatch(balances.preBalances[indexOf(account.address)] === 0
      && delta(account.address) === BigInt(account.rentLamports), 'Creation rent deltas differ from approval')
  }
  const inventory = input.accountsAndRents
  const snapshot = await connection.getMultipleAccountsInfoAndContext(inventory.map(a => key(a.address)), {
    commitment: 'finalized', minContextSlot: receipt.slot,
  })
  requireMatch(snapshot.context.slot >= receipt.slot && snapshot.value.length === inventory.length, 'Recovery snapshot incomplete')
  const accounts = {}
  for (const [i, item] of inventory.entries()) {
    const account = snapshot.value[i]
    const owner = item.role === 'launch' || item.role === 'poolRegistry' ? FRESH_DEVNET.launch.toBase58()
      : item.role === 'pool' ? FRESH_DEVNET.swap.toBase58() : manifest.quoteMint.owner
    requireMatch(account && !account.executable && account.owner.toBase58() === owner && account.data.length === item.bytes, 'Recovered account ownership/size mismatch')
    accounts[item.role] = account
  }
  const mint = decodeMint(accounts.mint.data), launch = decodeLaunch(accounts.launch.data), pool = decodePool(accounts.pool.data)
  const addresses = manifest.callbackAndAcceptancePdas
  requireMatch(mint.version === 1 && mint.name === input.args.name && mint.symbol === input.args.symbol && mint.uri === ''
    && mint.decimals === 6 && mint.supply === 1000000000000000n && mint.maxSupply === mint.supply
    && mint.creator.toBase58() === HLTEST_CREATOR && mint.mintAuthority === null && mint.metadataAuthority === null
    && mint.freezeAuthority === null && mint.hookAuthority === null && mint.hookProgram === null && mint.hookFlags === 0, 'Recovered mint differs from plain HLTEST')
  requireMatch(launch.version === 1 && launch.creator.toBase58() === HLTEST_CREATOR && launch.mint.toBase58() === HLTEST_MINT
    && launch.pool.toBase58() === addresses.pool && launch.quoteMint.toBase58() === manifest.quoteMint.address
    && launch.creatorFeeBps === 0 && launch.modules === 0 && launch.customHook === null && launch.customHookFlags === 0 && launch.config.equals(PublicKey.default)
    && isDeepStrictEqual(launch.rules, { ...NO_LAUNCH_RULES }) && launch.virtualQuote === 1000000000n
    && launch.status === 0 && !launch.creatorBought && launch.reserveTokens === 250000000000000n
    && launch.curveTokens === 750000000000000n && launch.lpFeeBps === 30 && launch.sniperWindowSecs === 30
    && launch.sniperStartBps === 8000 && launch.reserveHolding.toBase58() === addresses.launchReserve
    && launch.quoteHolding.toBase58() === addresses.launchQuote && launch.lpHolding.toBase58() === addresses.launchLp, 'Recovered launch differs from plain HLTEST')
  requireMatch(pool.version === 1 && pool.baseMint.toBase58() === HLTEST_MINT && pool.quoteMint.toBase58() === manifest.quoteMint.address
    && pool.hookProgram?.equals(FRESH_DEVNET.launch) && pool.hookFlags === 1985 && pool.lpFeeBps === 30
    && pool.feeModel === 1 && pool.protocolFeeBps === 0 && pool.protocolShareBps === 2500
    && pool.baseVault.toBase58() === addresses.baseVault && pool.quoteVault.toBase58() === addresses.quoteVault
    && pool.lpMint.toBase58() === addresses.lpMint && pool.creator.toBase58() === addresses.launch
    && pool.curve && pool.swapCount === 0n && pool.baseReserve === 750000000000000n && pool.quoteReserve === 0n
    && pool.virtualBase === 375000000000000n && pool.virtualQuote === 1000000000n && pool.lpSupply === 0n, 'Recovered nested pool differs or has traded')
  const lpMint = decodeMint(accounts.lpMint.data)
  requireMatch(lpMint.version === 1 && lpMint.supply === 0n && lpMint.mintAuthority?.toBase58() === addresses.pool
    && lpMint.hookProgram === null && lpMint.freezeAuthority === null, 'Recovered LP mint differs')
  const holdings = {}
  for (const [role, mintAddress, owner] of [
    ['launchReserve', HLTEST_MINT, addresses.launch], ['launchQuote', manifest.quoteMint.address, addresses.launch],
    ['baseVault', HLTEST_MINT, addresses.pool], ['quoteVault', manifest.quoteMint.address, addresses.pool],
    ['launchLp', addresses.lpMint, addresses.launch],
  ]) {
    const holding = decodeHolding(accounts[role].data)
    requireMatch(holding.version === 1 && holding.mint.toBase58() === mintAddress && holding.owner.toBase58() === owner
      && !holding.frozen && holding.delegate === null, 'Recovered holding identity differs')
    holdings[role] = holding.amount.toString()
  }
  requireMatch(isDeepStrictEqual(holdings, { launchReserve: '250000000000000', launchQuote: '0',
    baseVault: '750000000000000', quoteVault: '0', launchLp: '0' }), 'Holdings changed after creation; investigate before acceptance')
  return { ...verification, signature, status: 'finalized', finalizedSlot: receipt.slot, observedSlot: snapshot.context.slot,
    actualDebitLamports: '32870000', networkFeeLamports: '10000', treasuryCreditLamports: '10000000',
    launchState: json(launch), poolState: json(pool), mintState: json(mint), holdings,
    warning: 'Custom Hook Lab token, not SPL/Token-2022. Trading remains disabled. Curve creation mints no LP; the empty LP holding belongs to the launch PDA. No LP burn or external lock is claimed.' }
}
