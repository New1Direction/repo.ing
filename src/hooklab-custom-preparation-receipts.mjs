// Read-only candidate preparation reconciliation. Never a production proof or launch resolver.
// Explicit immutable blocked-owner, frozen max-wallet V1 and source-pinned inclusive V3 adapters; no caller-supplied adapters.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import bs58 from 'bs58'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { z } from 'zod'
import { planCustomPreparation } from './hooklab-custom-preparation.mjs'
import { planSelectedHookPreparation } from './hooklab-selected-hook-preparation.mjs'
import { planMaxWalletPreparation, deriveMaxWalletPreparedAccounts } from './hooklab-max-wallet-preparation.mjs'
import { planInclusiveMaxWalletPreparation, deriveInclusiveMaxWalletPreparedAccounts } from './hooklab-inclusive-max-wallet-preparation.mjs'
import { inspectHookLabMessage, verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const pk = value => new PublicKey(value)
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const address = z.string().max(44).refine(value => { try { return pk(value).toBase58() === value } catch { return false } })
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const safeAmount = z.string().regex(/^(0|[1-9]\d{0,15})$/).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER))
const commitment = z.enum(['processed', 'confirmed', 'finalized'])
const modes = z.enum(['synthetic-fixture', 'configured-readonly-rpc'])
const policyKind = 'immutable-canonical-single-blocked-owner'
const isSelectedInput = input => input?.request?.schema === 'repoing/selected-hook-preparation-request/1'
const maxWalletProfileSha256 = 'f366d222e7257e86ac23d8350741b3c20c08ea084a4445c7b0d2d913593b5ea0'
const isInclusiveInput = input => input?.request?.schema === 'repoing/inclusive-max-wallet-preparation-request/1'
const isMaxWalletInput = input => input?.request?.schema === 'repoing/max-wallet-preparation-request/1' || isInclusiveInput(input)
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const disabled = Object.freeze({ canSign: false, canSubmit: false, canRetry: false, adoption: false,
  deploymentAdopted: false, artifactAdopted: false, policyApproved: false, executionAuthorized: false,
  preparationReceiptAccepted: false, productionPreparationReceiptAccepted: false, productionPreparationReceipt: null,
  chainVerified: false, historicalStateVerified: false, rentCapEnforcedOnchain: false, launchPlan: null })
export const CUSTOM_PREPARATION_EVIDENCE_LIMITS = Object.freeze({ maxEvidenceBytes: 4 * 1024 * 1024,
  maxBlockSignatures: 16384, maxAccounts: 256, maxNodes: 100000, maxDepth: 32,
  maxReadMs: 5000, maxCollectionMs: 15000, maxProviderCalls: 4 })

// Bounded canonical JSON, rejecting accessors, cycles, non-JSON and unsafe numeric input before hashing.
// Keeping object-key order out of the digest makes replay after JSONB storage deterministic.
function canonical(value, maxBytes = CUSTOM_PREPARATION_EVIDENCE_LIMITS.maxEvidenceBytes) {
  let size = 0, nodes = 0
  const active = new Set()
  const visit = (v, depth) => {
    check(depth <= 32 && ++nodes <= 100000, 'EVIDENCE_LIMIT')
    let out
    if (v === null || typeof v === 'boolean') out = JSON.stringify(v)
    else if (typeof v === 'string') { check(v.length <= maxBytes, 'EVIDENCE_LIMIT'); out = JSON.stringify(v) }
    else if (typeof v === 'number') { check(Number.isSafeInteger(v), 'UNSAFE_INTEGER'); out = String(v) }
    else {
      check(v && typeof v === 'object' && !active.has(v), 'INVALID_JSON')
      check(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'INVALID_JSON')
      active.add(v)
      const keys = Object.keys(v)
      check(keys.length <= 16384 && (!Array.isArray(v) || keys.length === v.length), 'EVIDENCE_LIMIT')
      for (const key of keys) check(Object.hasOwn(Object.getOwnPropertyDescriptor(v, key), 'value'), 'INVALID_JSON')
      out = Array.isArray(v) ? '[' + v.map(x => visit(x, depth + 1)).join(',') + ']'
        : '{' + keys.sort().map(key => JSON.stringify(key) + ':' + visit(v[key], depth + 1)).join(',') + '}'
      active.delete(v)
    }
    // Count leaf strings plus containers conservatively; this intentionally errs toward rejecting.
    size += Buffer.byteLength(out)
    check(size <= maxBytes * 8 && Buffer.byteLength(out) <= maxBytes, 'EVIDENCE_LIMIT')
    return out
  }
  return visit(value, 0)
}
function raw(text, max) {
  check(typeof text === 'string' && text.length <= Math.ceil(max / 3) * 4, 'INVALID_BYTES')
  const bytes = Buffer.from(text, 'base64')
  check(bytes.length <= max && bytes.toString('base64') === text, 'INVALID_BYTES')
  return bytes
}
const noRules = { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0,
  max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 }
const ruleFields = Object.keys(noRules).map((name, i) => ({ name, type: i < 5 ? 'u16' : 'u32' }))
const selectedFields = [{ name: 'version', type: 'u8' }, { name: 'creator', type: 'pubkey' },
  { name: 'rules', type: { defined: { name: 'LaunchRules' } } }, { name: 'creator_fee_bps', type: 'u16' },
  { name: 'custom_hook', type: { option: 'pubkey' } }, { name: 'custom_hook_flags', type: 'u16' },
  { name: 'label', type: 'string' }, { name: 'created_at', type: 'i64' }, { name: 'author_share_bps', type: 'u16' },
  { name: 'reserved', type: { array: ['u8', 30] } }]
function bindings(input) {
  const profile = JSON.parse(input.profile.json)
  const maxWallet = isMaxWalletInput(input)
  check(isSelectedInput(input) ? input.request.policyKind === 'selected-hook' : maxWallet
    ? input.request.policyKind === 'max-wallet' && input.request.policyVersion === (isInclusiveInput(input) ? 2 : 1)
      && profile.capability.kind === 'immutable-initial-supply-owner-cap-until-authenticated-graduation'
      && (isInclusiveInput(input) ? profile.buildFeature === 'inclusive-fees-candidate' && profile.capability.feeModel === 2 && profile.capability.protocolShareBps === 2500 : input.profile.expectedSha256 === maxWalletProfileSha256)
    : profile.capability.kind === policyKind, 'UNSUPPORTED_POLICY_ABI')
  const bind = role => {
    const bytes = raw(input.profile.idls[role], 1100000)
    check(sha(bytes) === profile.idlSha256[role], 'IDL_PIN_MISMATCH')
    const idl = JSON.parse(bytes)
    check(idl.address === profile.programs[role], 'IDL_IDENTITY_MISMATCH')
    return { idl, coder: new BorshCoder(idl) }
  }
  const gate = bind('gate'), launch = bind('launch')
  const struct = (bound, name, fields) => {
    const type = bound.idl.types.find(t => t.name === name)?.type
    check(type?.kind === 'struct' && isDeepStrictEqual(type.fields.map(({ name, type }) => ({ name, type })), fields), 'UNSUPPORTED_POLICY_ABI')
  }
  if (!isSelectedInput(input)) struct(gate, isInclusiveInput(input) ? 'PolicyV2' : 'Policy', maxWallet
    ? [{ name: 'version', type: 'u8' }, { name: 'mint', type: 'pubkey' }, { name: 'initial_supply', type: 'u64' },
      { name: 'cap_bps', type: 'u16' }, { name: 'quote_mint', type: 'pubkey' }, { name: 'lp_fee_bps', type: 'u16' },
      ...(isInclusiveInput(input) ? [{name:'fee_model',type:'u8'},{name:'protocol_share_bps',type:'u16'},{name:'creator_fee_bps',type:'u16'}] : [])]
    : [{ name: 'mint', type: 'pubkey' }, { name: 'blocked_owner', type: 'pubkey' }])
  struct(launch, 'LaunchRules', ruleFields); struct(launch, 'LaunchConfig', selectedFields)
  for (const [bound, name] of [...(isSelectedInput(input) ? [] : [[gate, isInclusiveInput(input) ? 'PolicyV2' : 'Policy']]), [launch, 'LaunchConfig']]) {
    check(isDeepStrictEqual(bound.idl.accounts.find(a => a.name === name)?.discriminator,
      [...Buffer.from(sha(`account:${name}`), 'hex').subarray(0, 8)]), 'ACCOUNT_DISCRIMINATOR_MISMATCH')
  }
  return { profile, gate, launch }
}
function encoded(bound, name, values, size) {
  const bytes = Buffer.concat([Buffer.from(bound.idl.accounts.find(a => a.name === name).discriminator), bound.coder.types.encode(name, values)])
  check(bytes.length <= size, 'ACCOUNT_SIZE_MISMATCH')
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)])
}
function maxWalletAccounts(input, createdAt) {
  const profile = JSON.parse(input.profile.json)
  const launchConfigAddress = PublicKey.findProgramAddressSync([Buffer.from('config')], pk(profile.programs.launch))[0].toBase58()
  const launchConfig = input.observations[0].accounts.find(a => a.address === launchConfigAddress)?.account
  return (isInclusiveInput(input) ? deriveInclusiveMaxWalletPreparedAccounts : deriveMaxWalletPreparedAccounts)({ profile: { json: input.profile.json, expectedSha256: input.profile.expectedSha256, idls: input.profile.idls },
    request: input.request, launchConfig, observedCreatedAtUnixSeconds: createdAt })
}
function selectedBytes(input, bound, createdAt) {
  if (isMaxWalletInput(input)) return raw(maxWalletAccounts(input, createdAt).accounts.selectedConfig.dataBase64, 176)
  const r = input.request
  return encoded(bound.launch, 'LaunchConfig', { version: 1, creator: pk(r.creator), rules: noRules,
    creator_fee_bps: isSelectedInput(input) ? r.creatorFeeBps : 0,
    custom_hook: pk(isSelectedInput(input) ? r.selectedHook.program : bound.profile.programs.gate), custom_hook_flags: isSelectedInput(input) ? r.hookFlags : 1,
    label: r.label, created_at: new BN(createdAt), author_share_bps: 0, reserved: Array(30).fill(0) }, 176)
}

/** expectedProfileSha256 is independent SERVER configuration, not profile.expectedSha256 from a request.
 * Rebuilds the original reviewed plan at its retained review time; expiry never authorizes replacement.
 * created_at is a Clock-dependent field. The template does not pretend that retained input fixes it.
 */
export function deriveCustomPreparationRecord(preparationInput, expectedProfileSha256) {
  digest.parse(expectedProfileSha256)
  // Retained inputs can include bounded ELF snapshots; no arbitrary supplied expected byte adapter.
  canonical(preparationInput, 64 * 1024 * 1024)
  check(preparationInput?.profile?.expectedSha256 === expectedProfileSha256
    && sha(preparationInput.profile.json) === expectedProfileSha256, 'SERVER_PROFILE_PIN_MISMATCH')
  const input = structuredClone(preparationInput), maxWallet = isMaxWalletInput(input)
  if (maxWallet && !isInclusiveInput(input)) check(expectedProfileSha256 === maxWalletProfileSha256, 'SERVER_PROFILE_PIN_MISMATCH')
  const plan = isSelectedInput(input) ? planSelectedHookPreparation(input) : isInclusiveInput(input) ? planInclusiveMaxWalletPreparation(input) : maxWallet ? planMaxWalletPreparation(input) : planCustomPreparation(input), bound = bindings(input)
  const descriptor = (role, accountAddress, owner, bytes) => ({ role, address: accountAddress, owner,
    executable: false, size: bytes.length, dataBase64: bytes.toString('base64'), sha256: sha(bytes) })
  if (isSelectedInput(input)) {
    const template = selectedBytes(input, bound, '0')
    const registry = input.observations[0].accounts.find(a => a.address === plan.addresses.registry).account
    return freeze({ schema: 'repoing/custom-preparation-record/1', plan, profileSha256: expectedProfileSha256,
      preparationInputSha256: sha(canonical(input, 64 * 1024 * 1024)), policyKind: 'selected-hook', policyVersion: 2,
      expectedAbsent: [input.request.mint, plan.addresses.canonicalLaunch],
      committedAccounts: { registry: descriptor('registry', registry.address, registry.owner, raw(registry.dataBase64, 16384)) },
      expectedAccounts: { selectedConfig: { ...descriptor('selectedConfig', input.request.selectedConfig, plan.addresses.launch, template),
        dataBase64: null, sha256: null, canonicalTemplateBase64: template.toString('base64'), dynamicFields: ['created_at'] } }, ...disabled })
  }
  const prepared = maxWallet ? maxWalletAccounts(input, '0') : null
  const policy = maxWallet ? raw(prepared.accounts.policy.dataBase64, isInclusiveInput(input) ? 90 : 85)
    : encoded(bound.gate, 'Policy', { mint: pk(input.request.mint), blocked_owner: pk(input.request.blockedOwner) }, 72)
  const registry = maxWallet ? raw(prepared.accounts.registry.dataBase64, 81)
    : Buffer.concat([Buffer.from('02daf6662c38c0cd01010000000000', 'hex'), pk(plan.addresses.policy).toBuffer()])
  if (maxWallet) check(isDeepStrictEqual(prepared.expectedAbsent, [plan.addresses.canonicalLaunch]), 'UNSUPPORTED_POLICY_ABI')
  const template = selectedBytes(input, bound, '0')
  return freeze({ schema: 'repoing/custom-preparation-record/1', plan, profileSha256: expectedProfileSha256,
    preparationInputSha256: sha(canonical(input, 64 * 1024 * 1024)), policyKind: maxWallet ? 'max-wallet' : policyKind,
    ...(maxWallet ? { policyVersion: input.request.policyVersion, policyEconomics: plan.policy, expectedAbsent: prepared.expectedAbsent } : {}),
    expectedAccounts: { policy: descriptor('policy', plan.addresses.policy, plan.addresses.gate, policy),
      registry: descriptor('registry', plan.addresses.registry, plan.addresses.gate, registry),
      selectedConfig: { ...descriptor('selectedConfig', input.request.selectedConfig, plan.addresses.launch, template),
        dataBase64: null, sha256: null, canonicalTemplateBase64: template.toString('base64'), dynamicFields: ['created_at'] } },
    ...disabled })
}
const signature = z.string().min(64).max(88).refine(value => { try { return bs58.decode(value).length === 64 } catch { return false } })
const transactionSchema = z.object({ slot: integer, blockTime: integer.nullable(), signedTransactionBase64: z.string().max(1644),
  loadedAddresses: z.object({ writable: z.array(address).max(256), readonly: z.array(address).max(256) }).strict(),
  feeLamports: safeAmount, err: z.union([z.null(), z.string().max(256), z.record(z.string().max(128), z.unknown())]),
  preBalances: z.array(safeAmount).min(1).max(256), postBalances: z.array(safeAmount).min(1).max(256),
}).strict()
const blockSchema = z.object({ slot: integer, blockhash: address, previousBlockhash: address, parentSlot: integer,
  blockHeight: integer.nullable(), blockTime: integer.nullable(), signatures: z.array(signature).min(1).max(16384) }).strict()
const stateAccountSchema = z.object({ role: z.enum(['policy', 'registry', 'selectedConfig']), address, owner: address,
  executable: z.boolean(), dataBase64: z.string().max(21848), lamports: safeAmount }).strict()
const programAccountSchema = z.object({ role: z.enum(['launch', 'gate', 'launchProgramData', 'gateProgramData', 'hook', 'hookProgramData']), address, owner: address,
  executable: z.boolean(), dataBase64: z.string().max(14000000), lamports: safeAmount }).strict()
const observationSchema = z.object({ provider: providerId, genesisHash: address.nullable(), transactionCommitment: commitment,
  transaction: transactionSchema.nullable(), blockCommitment: commitment, block: blockSchema.nullable(),
  snapshot: z.object({ slot: integer, commitment, accounts: z.array(stateAccountSchema).min(2).max(3) }).strict().nullable(),
  programSnapshot: z.object({ slot: integer, commitment, accounts: z.array(programAccountSchema).length(4) }).strict().nullable(),
  errorCode: z.enum(['READ_UNAVAILABLE', 'READ_TIMEOUT', 'INVALID_RESPONSE', 'EVIDENCE_LIMIT']).nullable(),
  rawResponseSha256: digest.nullable().optional(),
  absenceSnapshot: z.object({ slot: integer, commitment,
    accounts: z.array(z.object({ address, exists: z.boolean() }).strict()).min(1).max(2) }).strict().nullable().optional(),
}).strict()
const providersSchema = z.array(providerId).length(2).refine(p => new Set(p).size === 2)
const reasons = {
  INVALID_INPUT: 'Retained preparation input or signed bytes failed verification',
  INVALID_EVIDENCE: 'Evidence is malformed, unsafe, oversized or contains unsupported assertions',
  PROVIDER_BINDING: 'Two distinct independently configured provider identities are required',
  READ_UNAVAILABLE: 'One or more finalized reads are unavailable; retain the original transaction',
  PENDING_FINALITY: 'Evidence is not finalized; retain the original transaction',
  EVIDENCE_DISAGREEMENT: 'Providers disagree on transaction, inclusion or immutable prepared state',
  IDENTITY_MISMATCH: 'Transaction, chain, block identity or loaded account inventory differs',
  FINALIZED_FAILURE: 'Both providers report the exact included transaction failed; no retry is authorized',
  STATE_MISMATCH: 'Canonical immutable prepared accounts are missing or differ',
  SOURCE_MISMATCH: 'Finalized current program identity, pinned bytes or pre-transaction deployment evidence differs',
  ECONOMIC_MISMATCH: 'Exact transaction balance changes, fee basis or reviewed bounds differ',
  CURRENT_LAUNCH_PRESENT: 'Canonical Launch currently exists; earlier immutable preparation evidence remains retainable, but current pre-launch eligibility is closed',
  CURRENT_LAUNCH_UNRESOLVED: 'Current canonical Launch absence is unproven; this is not evidence of historical preparation corruption',
  MATCHED: 'Exact transaction, block inclusion, immutable current prepared state and native deltas match supplied evidence; production acceptance remains disabled',
}

/** Pure check of supplied assertions. evidenceMode labels provenance; it is NEVER authority.
 * Only the collector may source configured RPC observations. Neither API accepts accepted/finalized flags.
 * Later snapshots prove only matching current immutable bytes, never historical arbitrary balances.
 */
export function verifyCustomPreparationEvidence({ preparationInput, signedTransactionBase64, observations,
  expectedProfileSha256, expectedProviders, evidenceMode } = {}) {
  let record = null, signed = null, normalized = null, evidenceSha = null, providerNames = [], mode = null
  const finish = (status, reasonCode, details = {}) => freeze({ schema: 'repoing/custom-preparation-evidence-result/1',
    status, reason: reasons[reasonCode], reasonCode, signature: signed?.signature ?? null,
    messageSha256: signed?.messageSha256 ?? null, signedTransactionSha256: signed?.signedTransactionSha256 ?? null,
    profileSha256: record?.profileSha256 ?? null, preparationInputSha256: record?.preparationInputSha256 ?? null,
    policyKind: record?.policyKind ?? null,
    ...(record?.expectedAbsent ? { policyVersion: record.policyVersion, currentPrelaunchEligible: false,
      canonicalLaunchAbsenceHistorical: false, absenceEvidenceSemantics: 'current-prelaunch-eligibility-only' } : {}),
    rawEvidenceSha256: evidenceSha, providers: providerNames,
    evidenceMode: mode, evidenceAuthority: 'supplied-assertions-not-production-proof', observations: normalized,
    snapshotSemantics: 'current-immutable-preparation-state-only', ...details, ...disabled })
  try {
    mode = modes.parse(evidenceMode)
    record = deriveCustomPreparationRecord(preparationInput, expectedProfileSha256)
    signed = verifyHookLabSignedMessage(record.plan.review, signedTransactionBase64)
  } catch { return finish('unresolved', 'INVALID_INPUT') }
  try {
    providerNames = providersSchema.parse(expectedProviders)
    check(isDeepStrictEqual(providerNames, preparationInput.profile.providers), 'PROVIDER_BINDING')
  } catch { return finish('unresolved', 'PROVIDER_BINDING') }
  try {
    evidenceSha = sha(canonical(observations))
    normalized = z.array(observationSchema).length(2).parse(observations)
    check(record.expectedAbsent || normalized.every(o => !Object.hasOwn(o, 'absenceSnapshot')), 'INVALID_EVIDENCE')
    check(normalized.every(o => (!o.snapshot || o.snapshot.accounts.length === (record.policyKind === 'selected-hook' ? 2 : 3))
      && (!o.absenceSnapshot || o.absenceSnapshot.accounts.length === record.expectedAbsent?.length)
      && (record.policyKind === 'selected-hook' || !o.snapshot || o.snapshot.accounts.every(a => a.dataBase64.length <= 236))), 'INVALID_EVIDENCE')
  } catch { return finish('unresolved', 'INVALID_EVIDENCE') }
  if (new Set(normalized.map(o => o.provider)).size !== 2 || normalized.some(o => !providerNames.includes(o.provider))) return finish('unresolved', 'PROVIDER_BINDING')
  const [a, b] = providerNames.map(p => normalized.find(o => o.provider === p)), plan = record.plan
  if (normalized.some(o => o.genesisHash !== null && o.genesisHash !== plan.review.genesisHash)) return finish('unresolved', 'IDENTITY_MISMATCH')
  if (normalized.some(o => o.errorCode || !o.genesisHash || !o.transaction || !o.block)) return finish('unresolved', 'READ_UNAVAILABLE')
  if (normalized.some(o => o.transactionCommitment !== 'finalized' || o.blockCommitment !== 'finalized')) return finish('pending-finality', 'PENDING_FINALITY')
  if (!isDeepStrictEqual(a.transaction, b.transaction) || !isDeepStrictEqual(a.block, b.block)) return finish('unresolved', 'EVIDENCE_DISAGREEMENT')
  const t = a.transaction, block = a.block
  try {
    check(t.signedTransactionBase64 === signedTransactionBase64 && t.slot >= plan.review.observedSlot
      && t.slot <= plan.review.validUntilSlot && block.slot === t.slot && block.parentSlot < block.slot && block.blockhash !== block.previousBlockhash
      && block.blockHeight !== null && block.blockHeight >= preparationInput.recentBlockhash.currentBlockHeight
      && block.blockHeight <= plan.review.lastValidBlockHeight
      && block.blockTime === t.blockTime, 'IDENTITY_MISMATCH')
    check(block.signatures.filter(s => s === signed.signature).length === 1 && new Set(block.signatures).size === block.signatures.length, 'IDENTITY_MISMATCH')
    const tx = VersionedTransaction.deserialize(raw(signedTransactionBase64, 1232)), message = tx.message
    const loaded = { writable: t.loadedAddresses.writable.map(pk), readonly: t.loadedAddresses.readonly.map(pk) }
    const keys = message.getAccountKeys({ accountKeysFromLookups: loaded })
    const actual = Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) }))
    check(isDeepStrictEqual(actual, plan.review.accounts) && t.preBalances.length === actual.length && t.postBalances.length === actual.length, 'IDENTITY_MISMATCH')
    check(t.loadedAddresses.writable.length === message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length, 0)
      && t.loadedAddresses.readonly.length === message.addressTableLookups.reduce((n, l) => n + l.readonlyIndexes.length, 0), 'IDENTITY_MISMATCH')
  } catch { return finish('unresolved', 'IDENTITY_MISMATCH') }
  const identity = { finalizedSlot: t.slot, blockhash: block.blockhash, blockHeight: block.blockHeight,
    transactionIndex: block.signatures.indexOf(signed.signature) }
  if (t.err !== null) {
    try {
      const fee = inspectHookLabMessage(plan.review).totalFeeLamports
      check(t.feeLamports === fee, 'ECONOMIC_MISMATCH')
      check(plan.review.accounts.every((account, i) => BigInt(t.postBalances[i]) - BigInt(t.preBalances[i])
        === (account.address === preparationInput.request.feePayer ? -BigInt(fee) : 0n)), 'ECONOMIC_MISMATCH')
      return finish('finalized-failure', 'FINALIZED_FAILURE', { ...identity, nativeDeltasVerified: true,
        feePayerNetworkFeeLamports: fee, rentLamports: '0', totalDebitLamports: fee })
    } catch { return finish('unresolved', 'ECONOMIC_MISMATCH', identity) }
  }
  if (normalized.some(o => !o.snapshot || !o.programSnapshot)) return finish('unresolved', 'READ_UNAVAILABLE', identity)
  if (normalized.some(o => o.snapshot.commitment !== 'finalized' || o.programSnapshot.commitment !== 'finalized')) return finish('pending-finality', 'PENDING_FINALITY', identity)
  // Snapshot lamports may drift from donations. They are validated for safe encoding, but excluded
  // from the immutable-state agreement and never used to infer transaction rent or wallet debits.
  const immutable = snapshot => snapshot.accounts.map(({ lamports, ...account }) => account)
  if (!isDeepStrictEqual(immutable(a.snapshot), immutable(b.snapshot))) return finish('unresolved', 'EVIDENCE_DISAGREEMENT', identity)
  let matchedProgramHashes
  try {
    check(normalized.every(o => o.programSnapshot.slot === o.snapshot.slot && o.snapshot.slot >= t.slot), 'SOURCE_MISMATCH')
    check(isDeepStrictEqual(immutable(a.programSnapshot), immutable(b.programSnapshot)), 'SOURCE_MISMATCH')
    matchedProgramHashes = checkCurrentPrograms(preparationInput, plan, a.programSnapshot, t.slot)
  } catch { return finish('unresolved', 'SOURCE_MISMATCH', identity) }
  let matchedAccountHashes, selectedConfigCreatedAt
  try {
    check(normalized.every(o => o.snapshot.slot >= t.slot), 'STATE_MISMATCH')
    check(isDeepStrictEqual(a.snapshot.accounts.map(account => account.role), Object.keys({ ...record.expectedAccounts, ...record.committedAccounts })), 'STATE_MISMATCH')
    const bound = bindings(preparationInput), hashes = {}
    for (const account of a.snapshot.accounts) {
      const expected = record.expectedAccounts[account.role] ?? record.committedAccounts?.[account.role], bytes = raw(account.dataBase64, expected.size)
      check(account.address === expected.address && account.owner === expected.owner && account.executable === false && bytes.length === expected.size, 'STATE_MISMATCH')
      if (account.role === 'selectedConfig') {
        const decoded = bound.launch.coder.accounts.decode('LaunchConfig', bytes)
        selectedConfigCreatedAt = decoded.created_at.toString(10)
        safeAmount.parse(selectedConfigCreatedAt)
        check(bytes.equals(selectedBytes(preparationInput, bound, selectedConfigCreatedAt)), 'STATE_MISMATCH')
      } else check(bytes.toString('base64') === expected.dataBase64, 'STATE_MISMATCH')
      hashes[account.role] = sha(bytes)
    }
    matchedAccountHashes = hashes
  } catch { return finish('unresolved', 'STATE_MISMATCH', identity) }
  try {
    const reviewedFee = inspectHookLabMessage(plan.review).totalFeeLamports
    check(t.feeLamports === reviewedFee && BigInt(t.feeLamports) <= BigInt(preparationInput.limits.maxNetworkFeeLamports), 'ECONOMIC_MISMATCH')
    const balances = plan.review.accounts.map((account, i) => ({ address: account.address, before: BigInt(t.preBalances[i]), after: BigInt(t.postBalances[i]) }))
    const changes = new Map(), add = (key, value) => changes.set(key, (changes.get(key) ?? 0n) + value)
    let rent = 0n
    for (const expected of Object.values(record.expectedAccounts)) {
      const balance = balances.find(b => b.address === expected.address)
      check(balance && balance.before === 0n && balance.after > 0n, 'ECONOMIC_MISMATCH')
      check(balance.after >= BigInt(preparationInput.observations[0].rentExemptionLamports[expected.role]), 'ECONOMIC_MISMATCH')
      rent += balance.after; add(expected.address, balance.after)
    }
    const fee = BigInt(t.feeLamports), r = preparationInput.request
    check(rent <= BigInt(preparationInput.limits.maxRentLamports) && rent + fee <= BigInt(preparationInput.limits.maxTotalDebitLamports), 'ECONOMIC_MISMATCH')
    add(r.creator, -rent); add(r.feePayer, -fee)
    check(balances.every(b => b.after - b.before === (changes.get(b.address) ?? 0n)), 'ECONOMIC_MISMATCH')
    // The canonical Launch is intentionally absent before stage two. A later Launch can legitimately
    // exist: this is a current eligibility condition, not historical preparation state or corruption.
    // These distinct non-conflict reasons preserve earlier finalized evidence in the unchanged journal.
    if (record.expectedAbsent) {
      if (normalized.some(o => !o.absenceSnapshot || o.absenceSnapshot.commitment !== 'finalized'
        || o.absenceSnapshot.slot !== o.snapshot.slot
        || !isDeepStrictEqual(o.absenceSnapshot.accounts.map(a => a.address), record.expectedAbsent))) {
        return finish('unresolved', 'CURRENT_LAUNCH_UNRESOLVED', identity)
      }
      if (normalized.some(o => o.absenceSnapshot.accounts.some(a => a.exists))) return finish('unresolved', 'CURRENT_LAUNCH_PRESENT', identity)
    }
    // No comparison to later wallet snapshots or stale reviewed balances: actual transaction deltas only.
    return finish('candidate-preparation-matched', 'MATCHED', { ...identity, matchedAccountHashes,
      ...(record.expectedAbsent ? { currentPrelaunchEligible: true, currentAbsentAccounts: record.expectedAbsent } : {}),
      snapshotSlots: normalized.map(o => ({ provider: o.provider, slot: o.snapshot.slot, relation: o.snapshot.slot > t.slot ? 'later-state' : 'same-slot-current-state' })),
      selectedConfigCreatedAt, selectedConfigCreationTimeProvenance: 'agreed-immutable-account-field-not-historical-clock-proof',
      nativeDeltasVerified: true, currentImmutableStateMatched: true, currentPinnedProgramBytesMatched: true, matchedProgramHashes,
      loaderHistoryAssumption: 'current-upgradeable-loader-deployment-slot-precedes-transaction-no-historical-replay',
      tokenDependencyProvenanceVerified: false, rentLamports: String(rent),
      creatorRentDebitLamports: String(rent), feePayerNetworkFeeLamports: String(fee), totalDebitLamports: String(rent + fee) })
  } catch { return finish('unresolved', 'ECONOMIC_MISMATCH', identity) }
}

function programInventory(plan) {
  return (plan.policyKind === 'selected-hook' ? ['launch', 'hook', 'launchProgramData', 'hookProgramData'] : ['launch', 'gate', 'launchProgramData', 'gateProgramData']).map(role => ({ role, address: plan.addresses[role] }))
}
function checkCurrentPrograms(input, plan, snapshot, transactionSlot) {
  check(isDeepStrictEqual(snapshot.accounts.map(a => ({ role: a.role, address: a.address })), programInventory(plan)), 'SOURCE_MISMATCH')
  const profile = JSON.parse(input.profile.json), accounts = new Map(snapshot.accounts.map(a => [a.role, a])), hashes = {}
  for (const role of (isSelectedInput(input) ? ['launch', 'hook'] : ['launch', 'gate'])) {
    const program = accounts.get(role), data = accounts.get(role + 'ProgramData'), length = role === 'hook' ? input.hookPin.elfLength : input.profile.elfLengths[role]
    check(program.owner === loader && program.executable === true && data.owner === loader && data.executable === false, 'SOURCE_MISMATCH')
    const pb = raw(program.dataBase64, 36), db = raw(data.dataBase64, 10485760 + 45)
    check(pb.length === 36 && pb.readUInt32LE(0) === 2 && pb.subarray(4).equals(pk(data.address).toBuffer()), 'SOURCE_MISMATCH')
    check(db.length >= 45 + length && db.readUInt32LE(0) === 3 && db.readBigUInt64LE(4) < BigInt(transactionSlot), 'SOURCE_MISMATCH')
    check(role === 'gate' || role === 'hook' ? db[12] === 0 : db[12] === 0 || db[12] === 1, 'SOURCE_MISMATCH')
    if (isSelectedInput(input)) {
      const retained = address => input.observations[0].accounts.find(a => a.address === address).account.dataBase64
      check(program.dataBase64 === retained(program.address) && data.dataBase64 === retained(data.address), 'SOURCE_MISMATCH')
    }
    // None authority leaves old authority bytes in the fixed 45-byte metadata region on the loader.
    // They must agree across providers but are not required to have been cleared.
    const elf = db.subarray(45, 45 + length)
    check(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha(elf) === (role === 'hook' ? input.hookPin.elfSha256 : profile.elfSha256[role])
      && db.subarray(45 + length).every(byte => byte === 0), 'SOURCE_MISMATCH')
    hashes[role] = { programSha256: sha(pb), programDataSha256: sha(db), elfSha256: sha(elf), deploymentSlot: String(db.readBigUInt64LE(4)) }
  }
  return hashes
}

// These are the only connection operations invoked. getMultipleAccountsInfoAndContext is web3's
// typed wrapper for getMultipleAccounts. Never sign, send, simulate, generate keys or call a wallet.
export const CUSTOM_PREPARATION_READ_METHODS = Object.freeze(['getGenesisHash', 'getTransaction', 'getBlockSignatures', 'getMultipleAccountsInfoAndContext'])
const amountFromRpc = value => { check(Number.isSafeInteger(value) && value >= 0, 'INVALID_RESPONSE'); return String(value) }
function normalizeTransaction(tx) {
  check(tx?.transaction?.message?.version === 0, 'INVALID_RESPONSE')
  const signed = new VersionedTransaction(tx.transaction.message)
  check(Array.isArray(tx.transaction.signatures) && tx.transaction.signatures.length <= 16, 'INVALID_RESPONSE')
  signed.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
  check(tx.meta && Array.isArray(tx.meta.preBalances) && Array.isArray(tx.meta.postBalances)
    && tx.meta.preBalances.length <= 256 && tx.meta.postBalances.length <= 256, 'INVALID_RESPONSE')
  const loaded = tx.meta.loadedAddresses
  check(loaded && Array.isArray(loaded.writable) && Array.isArray(loaded.readonly)
    && loaded.writable.length <= 256 && loaded.readonly.length <= 256, 'INVALID_RESPONSE')
  return transactionSchema.parse({ slot: tx.slot, blockTime: tx.blockTime,
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    loadedAddresses: { writable: loaded.writable.map(k => pk(k).toBase58()), readonly: loaded.readonly.map(k => pk(k).toBase58()) },
    feeLamports: amountFromRpc(tx.meta.fee), err: tx.meta.err,
    preBalances: tx.meta.preBalances.map(amountFromRpc), postBalances: tx.meta.postBalances.map(amountFromRpc) })
}
function captureHash(response) {
  // Digest of the bounded typed response, NOT original network bytes or provider authentication.
  // Prewalk before serializing so huge strings, buffers and row arrays do not create unbounded output.
  // Nonessential RPC numbers (e.g. rentEpoch) can already be rounded by web3. They are retained only
  // in this typed digest; all balances, fees, slots and fields used as evidence are checked separately.
  let bytes = 0, nodes = 0
  const seen = new Set(), max = CUSTOM_PREPARATION_EVIDENCE_LIMITS.maxEvidenceBytes
  const visit = (value, depth) => {
    check(depth <= 32 && ++nodes <= 100000, 'EVIDENCE_LIMIT')
    if (typeof value === 'string') {
      check(value.length <= max, 'EVIDENCE_LIMIT'); bytes += Buffer.byteLength(JSON.stringify(value))
    } else if (value instanceof PublicKey) bytes += 46
    else if (Buffer.isBuffer(value)) {
      // Buffer.toJSON expands each byte to a decimal plus a separator. Count
      // those digits without allocating the JSON; a worst-case four-byte
      // estimate rejects valid, sparse program snapshots below the same cap.
      check(value.length <= max, 'EVIDENCE_LIMIT')
      bytes += 26
      for (const byte of value) bytes += 2 + Number(byte >= 10) + Number(byte >= 100)
    }
    else if (value instanceof Uint8Array) bytes += 2 + value.length * 16
    else if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) bytes += 24
    else {
      check(value && typeof value === 'object' && !seen.has(value), 'INVALID_RESPONSE')
      seen.add(value)
      const keys = Object.keys(value)
      check(keys.length <= 16384 && (!Array.isArray(value) || value.length <= 16384), 'EVIDENCE_LIMIT')
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        check(Object.hasOwn(descriptor, 'value'), 'INVALID_RESPONSE')
        bytes += Buffer.byteLength(key) + 4; visit(descriptor.value, depth + 1)
      }
      seen.delete(value)
    }
    check(bytes <= max, 'EVIDENCE_LIMIT')
  }
  visit(response, 0)
  const text = JSON.stringify(response)
  check(typeof text === 'string' && Buffer.byteLength(text) <= max, 'EVIDENCE_LIMIT')
  return sha(text)
}

/** SERVER-ONLY collector configuration. Never accept providers/connections from an HTTP payload.
 * Each adapter is {provider,connection}; distinct object connections and, where exposed, endpoints
 * are required. That rejects accidental aliases, but cannot prove operational independence.
 * Promise deadlines bound waiting, not cancellation of a connection's in-flight I/O. Operators must
 * separately enforce network response-body limits, redirect/endpoint policy and transport aborts.
 * This collector checks retained evidence/row bounds after the configured transport returns data.
 */
export async function collectCustomPreparationEvidence({ preparationInput, signedTransactionBase64, providers,
  expectedProfileSha256, evidenceMode, limits = {} } = {}) {
  const mode = modes.parse(evidenceMode)
  const bounds = z.object({ readTimeoutMs: integer.positive().max(5000).default(5000),
    collectionTimeoutMs: integer.positive().max(15000).default(15000) }).strict().parse(limits)
  const record = deriveCustomPreparationRecord(preparationInput, expectedProfileSha256)
  const signed = verifyHookLabSignedMessage(record.plan.review, signedTransactionBase64)
  check(Array.isArray(providers) && providers.length === 2, 'PROVIDER_BINDING')
  const configuredIds = providersSchema.safeParse(providers.map(p => p.provider))
  check(configuredIds.success, 'PROVIDER_BINDING')
  const expectedProviders = configuredIds.data
  check(isDeepStrictEqual(expectedProviders, preparationInput.profile.providers), 'PROVIDER_BINDING')
  check(providers[0].connection !== providers[1].connection, 'PROVIDER_BINDING')
  const endpoints = providers.map(p => p.connection?.rpcEndpoint)
  check(!endpoints[0] || !endpoints[1] || endpoints[0] !== endpoints[1], 'PROVIDER_BINDING')
  check(providers.every(p => CUSTOM_PREPARATION_READ_METHODS.every(name => typeof p.connection?.[name] === 'function')), 'PROVIDER_BINDING')
  const deadline = Date.now() + bounds.collectionTimeoutMs
  const observations = await Promise.all(providers.map(async ({ provider, connection }) => {
    const observation = { provider, genesisHash: null, transactionCommitment: 'finalized', transaction: null,
      blockCommitment: 'finalized', block: null, snapshot: null, programSnapshot: null, errorCode: null, rawResponseSha256: null,
      ...(record.expectedAbsent ? { absenceSnapshot: null } : {}) }
    const hashes = []
    const read = async work => {
      const remaining = Math.min(bounds.readTimeoutMs, deadline - Date.now())
      check(remaining > 0, 'READ_TIMEOUT')
      let timer
      try {
        const response = await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('READ_TIMEOUT'), { code: 'READ_TIMEOUT' })), remaining)
        })])
        hashes.push(captureHash(response))
        return response
      } finally { clearTimeout(timer) }
    }
    try {
      observation.genesisHash = address.parse(await read(() => connection.getGenesisHash()))
      check(observation.genesisHash === record.plan.review.genesisHash, 'INVALID_RESPONSE')
      const tx = await read(() => connection.getTransaction(signed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }))
      if (tx !== null) {
        observation.transaction = normalizeTransaction(tx)
        const block = await read(() => connection.getBlockSignatures(observation.transaction.slot, 'finalized'))
        if (block !== null) observation.block = blockSchema.parse({ slot: observation.transaction.slot, blockhash: block.blockhash,
          previousBlockhash: block.previousBlockhash, parentSlot: block.parentSlot, blockHeight: block.blockHeight,
          blockTime: block.blockTime, signatures: block.signatures })
        if (observation.transaction.err === null && observation.block) {
          const expected = Object.values({ ...record.expectedAccounts, ...record.committedAccounts }), programAccounts = programInventory(record.plan)
          const absentAccounts = record.expectedAbsent ?? [], inventory = [...expected, ...programAccounts, ...absentAccounts.map(address => ({ address }))]
          const snapshot = await read(() => connection.getMultipleAccountsInfoAndContext(inventory.map(a => pk(a.address)),
            { commitment: 'finalized', minContextSlot: observation.transaction.slot }))
          check(snapshot && Array.isArray(snapshot.value) && snapshot.value.length === inventory.length, 'INVALID_RESPONSE')
          observation.snapshot = { slot: integer.parse(snapshot.context?.slot), commitment: 'finalized', accounts: expected.map((e, i) => {
            const a = snapshot.value[i]
            check(a && Buffer.isBuffer(a.data) && a.data.length === e.size, 'INVALID_RESPONSE')
            return { role: e.role, address: e.address, owner: pk(a.owner).toBase58(), executable: a.executable,
              dataBase64: a.data.toString('base64'), lamports: amountFromRpc(a.lamports) }
          }) }
          if (record.expectedAbsent) observation.absenceSnapshot = { slot: observation.snapshot.slot, commitment: 'finalized',
            accounts: absentAccounts.map((address, i) => {
              const account = snapshot.value[expected.length + programAccounts.length + i]
              check(account === null || account && Buffer.isBuffer(account.data)
                && typeof account.executable === 'boolean' && Number.isSafeInteger(account.lamports) && account.lamports >= 0, 'INVALID_RESPONSE')
              if (account !== null) pk(account.owner)
              return { address, exists: account !== null }
            }) }
          observation.programSnapshot = { slot: observation.snapshot.slot, commitment: 'finalized', accounts: programAccounts.map((e, i) => {
            const a = snapshot.value[i + expected.length]
            check(a && Buffer.isBuffer(a.data) && a.data.length <= 10485760 + 45, 'INVALID_RESPONSE')
            return { role: e.role, address: e.address, owner: pk(a.owner).toBase58(), executable: a.executable,
              dataBase64: a.data.toString('base64'), lamports: amountFromRpc(a.lamports) }
          }) }
        }
      }
    } catch (error) {
      observation.errorCode = ['READ_TIMEOUT', 'EVIDENCE_LIMIT'].includes(error?.code) ? error.code
        : error?.code === 'INVALID_RESPONSE' || error?.name === 'ZodError' ? 'INVALID_RESPONSE' : 'READ_UNAVAILABLE'
    }
    observation.rawResponseSha256 = sha(canonical(hashes))
    return observation
  }))
  const result = verifyCustomPreparationEvidence({ preparationInput, signedTransactionBase64, observations,
    expectedProfileSha256, expectedProviders, evidenceMode: mode })
  return freeze({ schema: 'repoing/custom-preparation-collection/1', observations, result,
    configuredProviders: expectedProviders, rawEvidenceSha256: result.rawEvidenceSha256,
    rawResponseDigestKind: 'typed-response-not-original-network-wire', transportAbortGuaranteed: false, ...disabled })
}


/** Server-only collection-to-journal orchestration. Providers/profile/mode must be independently
 * configured by the server. No observations, result, accepted flag or callback verifier is accepted.
 * Future configured-RPC ingestion must use this path rather than passing browser assertions to retain.
 * The journal remains candidate evidence storage; no public production resolver is connected.
 */
export async function collectAndRetainCustomPreparation(options = {}) {
  const allowed = ['journal', 'owner', 'id', 'preparationInput', 'signedTransactionBase64', 'providers', 'expectedProfileSha256', 'evidenceMode', 'limits']
  check(Object.keys(options).every(key => allowed.includes(key)), 'UNSUPPORTED_COLLECTION_ARGUMENT')
  const { journal, owner, id, preparationInput, signedTransactionBase64, providers, expectedProfileSha256, evidenceMode, limits } = options
  check(journal && typeof journal.retain === 'function', 'JOURNAL_REQUIRED')
  const collection = await collectCustomPreparationEvidence({ preparationInput, signedTransactionBase64, providers, expectedProfileSha256, evidenceMode, limits })
  check(collection.result.observations !== null, 'INVALID_COLLECTED_EVIDENCE')
  const record = await journal.retain(owner, id, { preparationInput, signedTransactionBase64, observations: collection.result.observations })
  return { schema: 'repoing/custom-preparation-collected-record/1', record, collection, ...disabled }
}
