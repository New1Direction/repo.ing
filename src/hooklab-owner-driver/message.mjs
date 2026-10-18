// Message compilation and canonical comparison. No signing.
import { AddressLookupTableAccount, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { inspectHookLabMessage } from '../hooklab-message-boundary.mjs'
import { pk, sha256, SYSTEM } from './pins.mjs'

export const LAMPORTS_PER_SIGNATURE = 5000n
const check = (ok, message) => { if (!ok) throw Error(message) }

export function lookupAccount(table) {
  return new AddressLookupTableAccount({ key: pk(table.address), state: AddressLookupTableAccount.deserialize(Buffer.from(table.dataBase64, 'base64')) })
}
export function priorityFee(units, microLamports) { return (BigInt(units) * BigInt(String(microLamports)) + 999999n) / 1000000n }

/** Compile a v0 message (compute-budget prefix supplied by the caller) and run the shared
 * message-boundary inspection so every stage passes the same wire/budget/fee checks. */
export function compileReviewed({ operation, genesisHash, profileSha256, payer, wallet, instructions, blockhash, lastValidBlockHeight, lookupTable = null,
  observedSlot, observedAtMs, validUntilSlot, units, microLamports, instructionDebitLamports = '0', policy }) {
  const tables = lookupTable ? [lookupAccount(lookupTable)] : []
  const message = new TransactionMessage({ payerKey: pk(payer), recentBlockhash: blockhash, instructions }).compileToV0Message(tables)
  const bytes = Buffer.from(message.serialize()), keys = message.getAccountKeys({ addressLookupTableAccounts: tables })
  const base = BigInt(message.header.numRequiredSignatures) * LAMPORTS_PER_SIGNATURE, priority = priorityFee(units, microLamports)
  const review = { schema: 'hooklab-message-review/1', operation, genesisHash, profileSha256, policySha256: sha256(JSON.stringify(policy ?? {})),
    intentSha256: sha256(JSON.stringify({ operation, payer })), payer, wallet: wallet ?? payer, messageBase64: bytes.toString('base64'), messageSha256: sha256(bytes),
    requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58()),
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: lookupTable ? [lookupTable] : [], observedSlot, validUntilSlot, observedAtMs, reviewExpiresAtMs: observedAtMs + 60000, lastValidBlockHeight,
    baseFeeLamports: String(base), maxFeeLamports: String(base + priority), instructionDebitLamports: String(instructionDebitLamports),
    maxNativeDebitLamports: String(base + priority + BigInt(String(instructionDebitLamports))) }
  check(!lookupTable || message.addressTableLookups.length === 1, 'Lookup table supplied but unused')
  inspectHookLabMessage(review)
  return { review, messageBytes: bytes }
}
export function unsignedTransactionBase64(messageBase64) {
  const message = VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64'))
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64')
}
/** Message bytes with the recent blockhash zeroed: used to prove a refresh changed nothing else. */
export function canonicalWithoutBlockhash(messageBase64) {
  const message = VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64'))
  message.recentBlockhash = SYSTEM
  return Buffer.from(message.serialize())
}
export function blockhashOf(messageBase64) { return VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64')).recentBlockhash }
export function signerList(messageBase64) {
  const message = VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64'))
  return message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58())
}
