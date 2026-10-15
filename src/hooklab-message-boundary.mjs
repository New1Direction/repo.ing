// Source-independent wire/evidence checks. NOT an instruction-policy verifier or execution permission.
// No connections, wallets, builders, key generation or send operations. Public execution stays disabled.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage,
  VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const key = z.string().max(44).refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
// getGenesisHash is a base58 identifier, not necessarily a 32-byte public key.
const genesis = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{16,44}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const u64 = z.string().regex(/^(0|[1-9]\d{0,19})$/).pipe(z.string().refine(v => BigInt(v) <= 0xffffffffffffffffn))
const base64 = z.string().max(65536)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const requireThat = (ok, message) => { if (!ok) throw new Error(message) }
function bytes(value, max) {
  const data = Buffer.from(value, 'base64')
  requireThat(data.length > 0 && data.length <= max && data.toString('base64') === value, 'Invalid canonical bytes')
  return data
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
const lookupOwner = 'AddressLookupTab1e1111111111111111111111111'
export const hookLabReviewSchema = z.object({
  schema: z.literal('hooklab-message-review/1'), operation: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  genesisHash: genesis, profileSha256: hash, policySha256: hash, intentSha256: hash,
  payer: key, wallet: key, messageBase64: z.string().max(1644), messageSha256: hash,
  requiredSigners: z.array(key).min(1).max(16),
  accounts: z.array(z.object({ address: key, signer: z.boolean(), writable: z.boolean() }).strict()).min(1).max(256),
  lookupTables: z.array(z.object({ address: key, owner: z.literal(lookupOwner), dataBase64: base64, sha256: hash }).strict()).max(8),
  observedSlot: integer, validUntilSlot: integer, observedAtMs: integer, reviewExpiresAtMs: integer,
  lastValidBlockHeight: integer, baseFeeLamports: u64, maxFeeLamports: u64,
  instructionDebitLamports: u64, maxNativeDebitLamports: u64,
}).strict()

/** Derive the review display from actual bytes and the retained ALT snapshots, not caller prose.
 * The producer must independently reconstruct/authorize these instructions and economic claims.
 */
export function inspectHookLabMessage(input) {
  const review = hookLabReviewSchema.parse(input), wire = bytes(review.messageBase64, 1232)
  const message = VersionedMessage.deserialize(wire)
  requireThat(message.version === 0 && Buffer.from(message.serialize()).equals(wire)
    && sha(wire) === review.messageSha256 && new VersionedTransaction(message).serialize().length <= 1232, 'Message bytes/hash/version mismatch')
  requireThat(review.validUntilSlot >= review.observedSlot && review.reviewExpiresAtMs > review.observedAtMs, 'Invalid review lifetime')
  requireThat(new Set(review.accounts.map(a => a.address)).size === review.accounts.length, 'Duplicate resolved account')
  requireThat(isDeepStrictEqual(review.lookupTables.map(t => t.address), message.addressTableLookups.map(t => t.accountKey.toBase58())), 'Lookup table list differs')
  const tables = review.lookupTables.map(t => {
    const raw = bytes(t.dataBase64, 16384)
    requireThat(sha(raw) === t.sha256, 'Lookup table hash differs')
    const state = AddressLookupTableAccount.deserialize(raw)
    requireThat(state.deactivationSlot === 0xffffffffffffffffn && state.lastExtendedSlot < review.observedSlot, 'Lookup table inactive or not warmed')
    return new AddressLookupTableAccount({ key: new PublicKey(t.address), state })
  })
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables })
  const resolved = Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(),
    signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) }))
  requireThat(isDeepStrictEqual(resolved, review.accounts), 'Resolved account order/privileges differ')
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58())
  requireThat(isDeepStrictEqual(signers, review.requiredSigners) && signers[0] === review.payer
    && signers.includes(review.wallet) && resolved[0].writable, 'Payer/wallet/signers differ')
  const instructions = TransactionMessage.decompile(message, { addressLookupTableAccounts: tables }).instructions
  // Exact explicit budget only; no runtime defaults, late changes, heap requests or duplicated budgets.
  let units = null, price = null, prefix = true
  for (const ix of instructions) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) { prefix = false; continue }
    requireThat(prefix && ix.keys.length === 0, 'Unexpected compute budget placement')
    if (ix.data[0] === 2 && ix.data.length === 5 && units === null) units = ix.data.readUInt32LE(1)
    else if (ix.data[0] === 3 && ix.data.length === 9 && price === null) price = ix.data.readBigUInt64LE(1)
    else throw new Error('Unknown or duplicate compute budget')
  }
  requireThat(!prefix && units > 0 && units <= 1400000 && price !== null, 'Explicit compute limit and price required')
  const priority = (BigInt(units) * price + 999999n) / 1000000n
  const totalFee = BigInt(review.baseFeeLamports) + priority
  requireThat(totalFee <= BigInt(review.maxFeeLamports)
    && totalFee + BigInt(review.instructionDebitLamports) <= BigInt(review.maxNativeDebitLamports), 'Reviewed native fee/debit cap exceeded')
  return freeze({ review, computeUnits: units, priorityFeeLamports: String(priority), totalFeeLamports: String(totalFee),
    instructions: instructions.map(ix => ({ program: ix.programId.toBase58(), dataHex: ix.data.toString('hex'),
      accounts: ix.keys.map(k => ({ address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })) })),
    policyVerified: false, canSign: false, canSubmit: false })
}

const observationSchema = z.object({ genesisHash: genesis, wallet: key, profileSha256: hash, policySha256: hash,
  slot: integer, blockHeight: integer, nowMs: integer, blockhashValid: z.boolean(), feeLamports: u64,
  lookupTableHashes: z.array(z.object({ address: key, sha256: hash }).strict()).max(8),
}).strict()

/** Check again before review, before requesting signatures and before any future broadcast.
 * Observations must come from authenticated application adapters, never client-provided authority.
 */
export function checkHookLabReviewFreshness(input, current) {
  const checked = inspectHookLabMessage(input), r = checked.review, c = observationSchema.parse(current)
  requireThat(c.genesisHash === r.genesisHash && c.wallet === r.wallet && c.profileSha256 === r.profileSha256
    && c.policySha256 === r.policySha256, 'Wallet/network/profile/policy changed')
  requireThat(c.slot >= r.observedSlot && c.slot <= r.validUntilSlot && c.nowMs >= r.observedAtMs
    && c.nowMs < r.reviewExpiresAtMs && c.blockHeight <= r.lastValidBlockHeight && c.blockhashValid, 'Review expired, future or blockhash invalid')
  requireThat(c.feeLamports === checked.totalFeeLamports, 'Network fee quote changed')
  requireThat(isDeepStrictEqual(c.lookupTableHashes, r.lookupTables.map(({ address, sha256 }) => ({ address, sha256 }))), 'Lookup table changed')
  return checked
}

/** Raw simulation result for the exact captured request. No replacement blockhash, fee fallback or silent rebuild.
 * Does not verify custom-token transfers, hooks, recipients or program-specific postconditions.
 */
export function checkHookLabSimulation(input, current, simulation) {
  const checked = checkHookLabReviewFreshness(input, current)
  requireThat(simulation?.messageSha256 === checked.review.messageSha256, 'Simulation request binding differs')
  const slot = integer.parse(simulation?.context?.slot)
  requireThat(slot >= checked.review.observedSlot && slot <= current.slot, 'Simulation slot outside observed window')
  requireThat(simulation.value?.err === null && !simulation.value.replacementBlockhash, 'Simulation failed or replaced blockhash')
  const units = integer.parse(simulation.value.unitsConsumed)
  requireThat(units > 0 && units <= checked.computeUnits, 'Simulation compute limit exceeded')
  return freeze({ ...checked, simulationSlot: slot, unitsConsumed: units, postconditionsVerified: false })
}

/** Retain existing signatures even after expiry/disconnect; that does not authorize submission. */
export function verifyHookLabSignedMessage(input, signedBase64) {
  const { review } = inspectHookLabMessage(input)
  const raw = bytes(z.string().max(1644).parse(signedBase64), 1232), tx = VersionedTransaction.deserialize(raw)
  requireThat(Buffer.from(tx.serialize()).equals(raw) && Buffer.from(tx.message.serialize()).toString('base64') === review.messageBase64, 'Wallet changed reviewed message')
  requireThat(tx.signatures.length === review.requiredSigners.length, 'Signature count mismatch')
  for (const [i, signer] of review.requiredSigners.entries()) {
    const pubkey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(signer).toBuffer()]), format: 'der', type: 'spki' })
    requireThat(verify(null, tx.message.serialize(), pubkey, tx.signatures[i]), 'Invalid or missing signature')
  }
  return freeze({ signature: bs58.encode(tx.signatures[0]), messageSha256: review.messageSha256,
    signedTransactionSha256: sha(raw), canSubmit: false })
}

/** Two provider-normalized finalized receipts. Missing/disagreeing evidence stays unresolved.
 * A transport/fee success does not settle a Hooks operation until the producer's postconditions pass.
 * Provider bindings come from reviewed operator configuration, never the receipt response itself.
 */
export function reconcileHookLabReceipts(input, signedBase64, receipts, expectedProviders) {
  const signed = verifyHookLabSignedMessage(input, signedBase64), checked = inspectHookLabMessage(input)
  const result = (status, reason) => freeze({ status, reason, signature: signed.signature,
    messageSha256: signed.messageSha256, postconditionsVerified: false, canRetry: false, canSubmit: false })
  if (!Array.isArray(expectedProviders) || expectedProviders.length !== 2 || new Set(expectedProviders).size !== 2
    || expectedProviders.some(p => typeof p !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(p))
    || !Array.isArray(receipts) || receipts.length !== 2 || receipts.some(r => !r?.receipt)
    || new Set(receipts.map(r => r.provider)).size !== 2
    || receipts.some(r => !expectedProviders.includes(r.provider))) return result('unresolved', 'Missing independent receipt evidence')
  if (!isDeepStrictEqual(receipts[0].receipt, receipts[1].receipt)) return result('unresolved', 'Providers disagree')
  const r = receipts[0].receipt
  if (r.genesisHash !== input.genesisHash || r.signature !== signed.signature || r.messageSha256 !== signed.messageSha256
    || r.signedTransactionBase64 !== signedBase64 || !Number.isSafeInteger(r.slot)
    || r.slot < input.observedSlot || r.error === undefined) return result('unresolved', 'Receipt identity or slot differs')
  if (r.confirmationStatus !== 'finalized') return result('pending-finality', 'Receipt is not finalized')
  if (r.feeLamports !== checked.totalFeeLamports) return result('unresolved', 'Finalized fee differs from review')
  return result(r.error === null ? 'finalized-transaction-only' : 'finalized-failure', 'Retain evidence; Hooks account/economic postconditions require the producer verifier')
}
