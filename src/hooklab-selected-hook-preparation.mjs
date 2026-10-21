// Config-only candidate compiler. No hook initialization, policy setup, custody or sends.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { z } from 'zod'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey, ComputeBudgetProgram, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { hookAddress as key, hookDigest as digest, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { parseInclusiveMaxWalletProfile } from './hooklab-inclusive-max-wallet-profile.mjs'
import { selectedHookSchema, selectedHookAccountPlan } from './hooklab-selected-hook.mjs'
import { selectedHookAuthorityEvidenceSchema } from './hooklab-selected-hook-compatibility.mjs'
import { parseLaunchConfigReserved } from './hooklab-launch-config-reserved.mjs'
import { profileRolesDistinct, otherPrograms, kitOf } from './hooklab-stack.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
const check = (v, m) => { if (!v) throw Error(m) }
const sha = b => createHash('sha256').update(b).digest('hex')
const pk = v => new PublicKey(v)
const pda = (p, ...s) => PublicKey.findProgramAddressSync(s.map(v => typeof v === 'string' ? Buffer.from(v) : v), pk(p))[0].toBase58()
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111', zero = '11111111111111111111111111111111'
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const role = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
const raw = (v, max) => { const b = Buffer.from(v, 'base64'); check(b.length <= max && b.toString('base64') === v, 'Noncanonical or oversized bytes'); return b }
export const selectedHookPreparationRequestSchema = z.object({
  schema: z.literal('repoing/selected-hook-preparation-request/1'), policyKind: z.literal('selected-hook'), policyVersion: z.literal(2),
  creator: key, feePayer: key, mint: key, selectedConfig: key, capBps: z.literal(0),
  label: z.string().refine(v => Buffer.byteLength(v, 'utf8') <= 32), creatorFeeBps: integer.max(9999),
  rules: z.union([z.literal('none'), z.object({ burnBuyBps: integer.max(10000), burnSellBps: integer.max(10000) }).strict()]),
  authorShareBps: integer.max(5000).optional(),
  quoteCut: z.object({ maxBuyBps: integer.min(1).max(1000), maxSellBps: integer.max(1000) }).strict().optional(),
  hookFlags: integer.min(1).max(255), selectedHook: selectedHookSchema, feeModel: z.union([z.literal(1), z.literal(2)]), protocolShareBps: z.literal(2500),
}).strict().refine(r => r.hookFlags === r.selectedHook.flags, 'Hook flags differ')
const account = z.object({ address: key, owner: key, executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: u64 }).strict()
const observation = z.object({ provider: role, genesisHash: key, commitment: z.literal('finalized'), slot: integer, observedAtMs: integer,
  accounts: z.array(z.object({ address: key, account: account.nullable() }).strict()).min(11).max(14),
  rentExemptionLamports: z.object({ selectedConfig: u64 }).strict(),
}).strict()
const limitsSchema = z.object({ nowMs: integer, maxAgeMs: integer.positive().max(60000), maxSlotLag: integer.max(150), validUntilSlot: integer,
  reviewExpiresAtMs: integer, maxRentLamports: u64, maxNetworkFeeLamports: u64, maxTotalDebitLamports: u64,
  computeUnitLimit: integer.positive().max(1400000), computeUnitPriceMicroLamports: u64 }).strict()
const artifactStrings = z.object({ launch: z.string().max(1500000), gate: z.string().max(1500000) }).strict()
const inputSchema = z.object({ profile: z.object({ json: z.string().max(16384), expectedSha256: digest, idls: artifactStrings,
  elfLengths: z.object({ launch: integer.positive().max(10485760), gate: integer.positive().max(10485760) }).strict(),
  providers: z.array(role).length(2).refine(v => new Set(v).size === 2) }).strict(),
  hookPin: z.object({ program: key, elfSha256: digest, elfLength: integer.min(4).max(10485760) }).strict(),
  request: selectedHookPreparationRequestSchema, selectedAuthorityEvidence: selectedHookAuthorityEvidenceSchema.optional(), observations: z.array(observation).length(2),
  recentBlockhash: z.object({ blockhash: key, genesisHash: key, providers: z.array(role).length(2), observedAtMs: integer,
    currentBlockHeight: integer.positive(), blockhashValid: z.literal(true), lastValidBlockHeight: integer.positive(), observedSlot: integer,
    networkFeeLamports: u64, lamportsPerSignature: u64.refine(v => BigInt(v) > 0n) }).strict(),
  limits: limitsSchema, lookupTable: z.null().optional(),
}).strict()
const rules = { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0, max_wallet_bps: 0,
  creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 }
export const selectedHookRules = r => ({ ...rules, ...(r.rules && r.rules !== 'none' ? { burn_buy_bps: r.rules.burnBuyBps, burn_sell_bps: r.rules.burnSellBps } : {}) })
export function selectedHookConfigReserved(r, timelocked = false) {
  const bytes = Buffer.alloc(30); bytes[0] = Number(timelocked)
  if (r.quoteCut) { bytes.writeUInt16LE(r.quoteCut.maxBuyBps, 1); bytes.writeUInt16LE(r.quoteCut.maxSellBps, 3) }
  return [...bytes]
}
export function assertSelectedHookRuleBounds(r, c) {
  const rules = selectedHookRules(r)
  check([rules.burn_buy_bps, rules.burn_sell_bps].every(b => b <= c.rule_bounds.max_burn_bps && b + r.creatorFeeBps <= c.rule_bounds.max_rules_fee_bps), 'Selected hook burn bounds differ')
}

export function selectedAuthorityAccounts(evidence) {
  if (!evidence) return []
  const e = selectedHookAuthorityEvidenceSchema.parse(evidence)
  return e.authority.kind === 'timelocked' ? [e.authority.timelock, e.authority.executor, e.authority.executorProgramData] : []
}
export function assertSelectedAuthorityObserved(evidence, accounts, genesisHash) {
  if (!evidence) return
  const e = selectedHookAuthorityEvidenceSchema.parse(evidence)
  check(e.genesisHash === genesisHash, 'Selected authority chain differs')
  for (const retained of [e.programAccount, e.programData, ...selectedAuthorityAccounts(e)]) {
    const observed = accounts.get(retained.address)
    check(observed && equal(retained, { address: observed.address, owner: observed.owner, executable: observed.executable, dataBase64: observed.dataBase64 }), 'Retained selected authority bytes differ')
  }
}

/** Independent profile and hook pins are server inputs, never browser authority.
 * Observations are assertions until collected/revalidated; this returns no signing capability.
 * feePayer must be creator: a separate fee payer would introduce a third signer.
 */
export function planSelectedHookPreparation(input) {
  const { profile: e, hookPin, selectedAuthorityEvidence, request: r, observations: obs, recentBlockhash: bh, limits: l } = inputSchema.parse(input)
  check(sha(e.json) === e.expectedSha256, 'Reviewed profile digest differs')
  const p = parseInclusiveMaxWalletProfile(JSON.parse(e.json)), L = p.programs.launch, H = r.selectedHook.program
  check(profileRolesDistinct(p) && hookPin.program === H, 'Profile or hook pin differs')
  const bind = role => {
    const b = raw(e.idls[role], 1048576), idl = JSON.parse(b)
    check(sha(b) === p.idlSha256[role] && idl.address === p.programs[role], 'IDL identity or digest differs')
    return { idl, coder: new BorshCoder(idl) }
  }
  const launch = bind('launch'); bind('gate') // Validate the full supplied profile envelope, never invoke gate.
  check(launch.idl.instructions.some(i => i.name === 'create_launch_open_v1'), 'Open launch ABI required')
  const addresses = { launch: L, hook: H, launchProgramData: pda(loader, pk(L).toBuffer()), hookProgramData: pda(loader, pk(H).toBuffer()),
    launchConfig: pda(L, 'config'), registry: pda(H, 'bordrless-hook-accounts', pk(r.mint).toBuffer()),
    canonicalLaunch: pda(L, 'launch', pk(r.mint).toBuffer()), eventAuthority: pda(L, '__event_authority') }
  const distinct = [...Object.values(addresses), ...otherPrograms(p), p.programs.gate, kitOf(p), p.quoteMint, r.creator, r.mint, r.selectedConfig, zero, ComputeBudgetProgram.programId.toBase58()]
  check(new Set(distinct).size === distinct.length && r.feePayer === r.creator, 'Preparation roles alias or third signer requested')
  check([r.creator, r.selectedConfig, r.mint].every(v => PublicKey.isOnCurve(pk(v).toBytes())), 'Required key cannot be a PDA')
  const inventory = [L, H, addresses.launchProgramData, addresses.hookProgramData, addresses.launchConfig, addresses.registry, r.mint, r.selectedConfig, r.creator, r.feePayer, addresses.canonicalLaunch]
  inventory.push(...selectedAuthorityAccounts(selectedAuthorityEvidence).map(a => a.address))
  check(new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => e.providers.includes(o.provider)), 'Provider binding differs')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && equal(obs[0].accounts, obs[1].accounts)
    && equal(obs[0].rentExemptionLamports, obs[1].rentExemptionLamports), 'Preparation observations disagree')
  let selected, registryBytes, hookProgramBytes, hookDataBytes, launchConfigBytes
  for (const o of obs) {
    check(equal(o.accounts.map(a => a.address), inventory), 'Incomplete preparation inventory')
    check(o.genesisHash === p.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain observation')
    check(equal(o.accounts[8], o.accounts[9]), 'Repeated payer evidence differs')
    const accounts = new Map(o.accounts.map(a => { check(a.account === null || a.account.address === a.address, 'Account identity differs'); return [a.address, a.account] }))
    assertSelectedAuthorityObserved(selectedAuthorityEvidence, accounts, p.genesisHash)
    for (const address of [r.mint, r.selectedConfig, addresses.canonicalLaunch]) check(accounts.get(address) === null, 'Preparation account already exists; do not retry')
    const payer = accounts.get(r.creator)
    check(payer && payer.owner === zero && !payer.executable && raw(payer.dataBase64, 0).length === 0, 'Payer is not a system account')
    const program = accounts.get(L), data = accounts.get(addresses.launchProgramData)
    check(program?.owner === loader && program.executable && data?.owner === loader && !data.executable, 'Launch program ownership differs')
    const pb = raw(program.dataBase64, 36), db = raw(data.dataBase64, 10485805)
    check(pb.length === 36 && pb.readUInt32LE() === 2 && pk(pb.subarray(4)).toBase58() === addresses.launchProgramData, 'Launch ProgramData linkage differs')
    check(db.length >= 45 + e.elfLengths.launch && db.readUInt32LE() === 3 && db.readBigUInt64LE(4) <= BigInt(o.slot)
      && [0, 1].includes(db[12]), 'Launch ProgramData state differs')
    const elf = db.subarray(45, 45 + e.elfLengths.launch)
    check(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha(elf) === p.elfSha256.launch && db.subarray(45 + e.elfLengths.launch).every(v => v === 0), 'Launch ELF differs')
    const registry = accounts.get(addresses.registry)
    if (!registry) throw Object.assign(Error('Selected hook registry must already be initialized by the creator for the reserved mint through the hook interface'), { code: 'SELECTED_HOOK_REGISTRY_REQUIRED' })
    const hp = accounts.get(H), hd = accounts.get(addresses.hookProgramData)
    hookProgramBytes = raw(hp?.dataBase64 ?? '', 36); hookDataBytes = raw(hd?.dataBase64 ?? '', 10485805)
    selected = selectedHookAccountPlan({ programs: p.programs, selectedHook: r.selectedHook, mint: r.mint, registry,
      programAccount: hp, programData: hd, elfSha256: hookPin.elfSha256, mintStable: true, feeModel: r.feeModel, selectedAuthorityEvidence })
    check(hookDataBytes.length === 45 + hookPin.elfLength && hookDataBytes.readBigUInt64LE(4) <= BigInt(o.slot), 'Hook length or slot differs')
    registryBytes = raw(registry.dataBase64, 16384)
    const config = accounts.get(addresses.launchConfig)
    check(config?.owner === L && !config.executable, 'Launch configuration owner differs')
    launchConfigBytes = raw(config.dataBase64, 250)
    const c = launch.coder.accounts.decode('Config', launchConfigBytes), canonical = Buffer.alloc(250)
    Buffer.from(launch.idl.accounts.find(a => a.name === 'Config').discriminator).copy(canonical); launch.coder.types.encode('Config', c).copy(canonical, 8)
    const menu = parseLaunchConfigReserved(c.reserved)
    assertSelectedHookRuleBounds(r, c)
    check(launchConfigBytes.length === 250 && canonical.equals(launchConfigBytes) && c.version === 1
      && c.bump === PublicKey.findProgramAddressSync([Buffer.from('config')], pk(L))[1] && menu, 'Launch configuration layout differs')
    check(menu.native && menu.open && !c.paused
      && r.creatorFeeBps <= c.max_creator_fee_bps && r.creatorFeeBps <= c.rule_bounds.max_rules_fee_bps
      && c.quote_mint.toBase58() === p.quoteMint && c.lp_fee_bps === 0 && c.sniper_window_secs.isZero() && c.sniper_start_bps === 0
      && BigInt(c.supply.toString()) > 0n, 'Selected-hook launch economics or native/open menu differs')
  }
  const slot = Math.max(...obs.map(o => o.slot))
  check(bh.genesisHash === p.genesisHash && equal(bh.providers, e.providers) && l.nowMs >= bh.observedAtMs && l.nowMs - bh.observedAtMs <= l.maxAgeMs
    && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review lifetime differs')
  const rent = BigInt(obs[0].rentExemptionLamports.selectedConfig), fee = BigInt(bh.networkFeeLamports)
  check(rent > 0n && rent <= BigInt(l.maxRentLamports) && fee <= BigInt(l.maxNetworkFeeLamports) && rent + fee <= BigInt(l.maxTotalDebitLamports), 'Preparation rent/network/debit cap exceeded')
  check(BigInt(obs[0].accounts[8].account.lamports) >= rent + fee, 'Preparation payer funds insufficient')
  const instruction = r.quoteCut ? 'create_quote_cut_config' : r.authorShareBps ? 'create_listed_config' : 'create_config'
  const abi = launch.idl.instructions.find(i => i.name === instruction)
  const expected = [['creator', true, true], ['config', false, false], ['launch_config', true, true], ['hook_program', false, false], ['system_program', false, false], ['event_authority', false, false], ['program', false, false]]
  check(abi && equal(abi.accounts.map(a => [a.name, !!a.writable, !!a.signer]), expected)
    && Buffer.from(abi.discriminator).equals(createHash('sha256').update(`global:${instruction}`).digest().subarray(0, 8)), 'Create config ABI differs')
  check(equal(abi.args, [{ name: 'args', type: { defined: { name: 'CreateConfigArgs' } } },
    ...(instruction !== 'create_config' ? [{ name: 'author_share_bps', type: 'u16' }] : []),
    ...(r.quoteCut ? [{ name: 'cut', type: { defined: { name: 'QuoteCut' } } }] : [])]), 'Create config argument ABI differs')
  if (r.quoteCut) check(equal(launch.idl.types.find(t => t.name === 'QuoteCut')?.type,
    { kind: 'struct', fields: [{ name: 'max_buy_bps', type: 'u16' }, { name: 'max_sell_bps', type: 'u16' }] }), 'Quote cut ABI differs')
  const values = { creator: r.creator, config: addresses.launchConfig, launch_config: r.selectedConfig, hook_program: H, system_program: zero, event_authority: addresses.eventAuthority, program: L }
  const ix = new TransactionInstruction({ programId: pk(L), keys: abi.accounts.map(a => {
    check(!a.address || a.address === values[a.name], 'Instruction fixed address differs')
    return { pubkey: pk(values[a.name]), isWritable: !!a.writable, isSigner: !!a.signer }
  }), data: launch.coder.instruction.encode(instruction, { args: { rules: selectedHookRules(r), creator_fee_bps: r.creatorFeeBps, custom_hook: pk(H), custom_hook_flags: r.hookFlags, label: r.label },
    ...(instruction !== 'create_config' ? { author_share_bps: r.authorShareBps ?? 0 } : {}),
    ...(r.quoteCut ? { cut: { max_buy_bps: r.quoteCut.maxBuyBps, max_sell_bps: r.quoteCut.maxSellBps } } : {}) }) })
  ix.keys.push({ pubkey: pk(addresses.hookProgramData), isSigner: false, isWritable: false })
  ix.keys.push(...selected.authorityAccounts.map(a => ({ pubkey: pk(a.address), isSigner: a.signer, isWritable: a.writable })))
  const message = new TransactionMessage({ payerKey: pk(r.creator), recentBlockhash: bh.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: l.computeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }), ix,
  ] }).compileToV0Message()
  const bytes = message.serialize(), keys = message.getAccountKeys(), priority = (BigInt(l.computeUnitLimit) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  check(message.header.numRequiredSignatures === 2 && fee === 2n * BigInt(bh.lamportsPerSignature) + priority, 'Network fee quote differs')
  const selectedEvidence = { ...selected, registrySha256: sha(registryBytes), programSha256: sha(hookProgramBytes), programDataSha256: sha(hookDataBytes), elfSha256: hookPin.elfSha256, elfLength: hookPin.elfLength, launchConfigSha256: sha(launchConfigBytes) }
  // Bind stable security-relevant state, not changing observation timestamps/slots or balances.
  const policySha256 = sha(JSON.stringify({ mint: r.mint, selectedConfig: r.selectedConfig, selectedHook: selectedEvidence, launchConfigSha256: sha(launchConfigBytes), launchElfSha256: p.elfSha256.launch }))
  const review = { schema: 'hooklab-message-review/1', operation: 'selected-hook-preparation', genesisHash: p.genesisHash, profileSha256: e.expectedSha256,
    policySha256, intentSha256: sha(JSON.stringify(r)), payer: r.creator, wallet: r.creator, messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes),
    requiredSigners: message.staticAccountKeys.slice(0, 2).map(k => k.toBase58()), accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: [], observedSlot: slot, validUntilSlot: l.validUntilSlot, observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs,
    lastValidBlockHeight: bh.lastValidBlockHeight, baseFeeLamports: String(fee - priority), maxFeeLamports: l.maxNetworkFeeLamports, instructionDebitLamports: String(rent), maxNativeDebitLamports: l.maxTotalDebitLamports }
  const inspected = inspectHookLabMessage(review), writable = new Set([r.creator, r.selectedConfig])
  check(inspected.instructions.length === 3 && review.accounts.every(a => a.signer === writable.has(a.address) && a.writable === writable.has(a.address)), 'Compiled preparation privileges differ')
  return freeze({ schema: 'repoing/selected-hook-preparation-plan/1', status: 'offline-unverified-preparation', request: r, addresses, review,
    instructions: inspected.instructions, selectedHook: selectedEvidence, ...(selectedAuthorityEvidence ? { selectedAuthorityEvidence } : {}), policyKind: 'selected-hook', policyVersion: 2, releaseProfileSha256: e.expectedSha256,
    sourceCommit: p.sourceCommit, sourcePatchSha256: p.sourcePatchSha256, rentAccountSizes: { selectedConfig: 176 }, rentQuoteLamports: String(rent),
    preparationReceiptAccepted: false, launchPlan: null, artifactAdopted: false, deploymentAdopted: false, policyApproved: false, executionAuthorized: false,
    publicExecutionEnabled: false, ownerApprovalVerified: false, rentCapEnforcedOnchain: false, feeEvidenceAuthenticated: false, canSign: false, canSubmit: false, canRetry: false })
}
