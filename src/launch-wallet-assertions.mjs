import { Message, Transaction, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'

export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
// Lighthouse v2 Borsh variants: account data/info, mint and token assertions.
// Deliberately exclude MemoryWrite/MemoryClose, delta, CPI and unknown variants.
// Source: github.com/Jac0xb/lighthouse/programs/lighthouse/src/instruction.rs
const ASSERTIONS = new Set([2, 3, 5, 6, 7, 8, 9, 10])

// Wallets (Phantom, esp. mobile) may append constrained Lighthouse safety assertions; accept only those.
export const matchesReviewedTransaction = (reviewedBytes, returned) => matchesReviewedLaunch(reviewedBytes, returned)

export function matchesReviewedLaunch(reviewedBytes, returned) {
  if (!(returned instanceof Transaction)) return false
  try {
    const actual = returned.compileMessage()
    if (Buffer.from(actual.serialize()).equals(reviewedBytes)) return true
    const reviewed = Message.from(reviewedBytes)
    const count = reviewed.instructions.length
    const additions = returned.instructions.slice(count)
    if (additions.length < 1 || additions.length > 4) return false
    const expectedKeys = new Set(reviewed.accountKeys.map(k => k.toBase58()))
    if (expectedKeys.has(LIGHTHOUSE_PROGRAM)) return false
    if (additions.some(ix => ix.programId.toBase58() !== LIGHTHOUSE_PROGRAM ||
      !ASSERTIONS.has(ix.data[0]) || ix.data.length < 3 || ix.data.length > 256 ||
      ix.keys.length !== 1 || !expectedKeys.has(ix.keys[0].pubkey.toBase58()))) return false

    // No new account authority, writable account, signer, payer or fee changes.
    if (actual.accountKeys.length !== reviewed.accountKeys.length + 1) return false
    for (let i = 0; i < actual.accountKeys.length; i++) {
      const key = actual.accountKeys[i]
      const j = reviewed.accountKeys.findIndex(k => k.equals(key))
      if (j < 0) {
        if (key.toBase58() !== LIGHTHOUSE_PROGRAM || actual.isAccountSigner(i) || actual.isAccountWritable(i)) return false
      } else if (actual.isAccountSigner(i) !== reviewed.isAccountSigner(j) ||
        actual.isAccountWritable(i) !== reviewed.isAccountWritable(j)) return false
    }
    // Removing ONLY trailing assertions must reproduce the reviewed message.
    const launch = new Transaction({ feePayer: returned.feePayer, recentBlockhash: returned.recentBlockhash })
      .add(...returned.instructions.slice(0, count))
    return Buffer.from(launch.serializeMessage()).equals(reviewedBytes)
  } catch { return false }
}

// The early access launch's v0 transaction (docs/EARLY_ACCESS.md), by the same rule: the reviewed message exactly, or that
// message with 1 to 4 trailing Lighthouse assertions and nothing else. Both messages are read through their lookup tables
// (loadLookupTables(message) → the AddressLookupTableAccounts it names), so an account moved between the static keys and the
// table cannot hide a change; removing only the trailing assertions and compiling again must give the reviewed bytes.
export async function matchesReviewedVersionedLaunch(reviewedBytes, returned, loadLookupTables) {
  if (!(returned instanceof VersionedTransaction) || returned.version !== 0) return false
  try {
    if (Buffer.from(returned.message.serialize()).equals(reviewedBytes)) return true
    const reviewed = VersionedMessage.deserialize(reviewedBytes), actual = returned.message
    if (reviewed.version !== 0) return false
    const tableKeys = message => message.addressTableLookups.map(lookup => lookup.accountKey.toBase58()).join(',')
    if (tableKeys(reviewed) !== tableKeys(actual)) return false
    const tables = await loadLookupTables(reviewed)
    const original = TransactionMessage.decompile(reviewed, { addressLookupTableAccounts: tables })
    const changed = TransactionMessage.decompile(actual, { addressLookupTableAccounts: tables })
    const count = original.instructions.length
    const additions = changed.instructions.slice(count)
    if (additions.length < 1 || additions.length > 4) return false
    const reviewedKeys = reviewed.getAccountKeys({ addressLookupTableAccounts: tables }).keySegments().flat()
    const expectedKeys = new Set(reviewedKeys.map(k => k.toBase58()))
    if (expectedKeys.has(LIGHTHOUSE_PROGRAM)) return false
    if (additions.some(ix => ix.programId.toBase58() !== LIGHTHOUSE_PROGRAM ||
      !ASSERTIONS.has(ix.data[0]) || ix.data.length < 3 || ix.data.length > 256 ||
      ix.keys.length !== 1 || !expectedKeys.has(ix.keys[0].pubkey.toBase58()))) return false
    // No new account authority, writable account, signer, payer or fee changes.
    const actualKeys = actual.getAccountKeys({ addressLookupTableAccounts: tables }).keySegments().flat()
    if (actualKeys.length !== reviewedKeys.length + 1 || !changed.payerKey.equals(original.payerKey)) return false
    for (let i = 0; i < actualKeys.length; i++) {
      const j = reviewedKeys.findIndex(k => k.equals(actualKeys[i]))
      if (j < 0) {
        if (actualKeys[i].toBase58() !== LIGHTHOUSE_PROGRAM || actual.isAccountSigner(i) || actual.isAccountWritable(i)) return false
      } else if (actual.isAccountSigner(i) !== reviewed.isAccountSigner(j) || actual.isAccountWritable(i) !== reviewed.isAccountWritable(j)) return false
    }
    const launch = new TransactionMessage({ payerKey: changed.payerKey, recentBlockhash: changed.recentBlockhash,
      instructions: changed.instructions.slice(0, count) }).compileToV0Message(tables)
    return Buffer.from(launch.serialize()).equals(reviewedBytes)
  } catch { return false }
}
