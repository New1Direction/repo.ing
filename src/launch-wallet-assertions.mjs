import { Message, Transaction } from '@solana/web3.js'

export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
// Lighthouse v2 Borsh variants: account data/info, mint and token assertions.
// Deliberately exclude MemoryWrite/MemoryClose, delta, CPI and unknown variants.
// Source: github.com/Jac0xb/lighthouse/programs/lighthouse/src/instruction.rs
const ASSERTIONS = new Set([2, 3, 5, 6, 7, 8, 9, 10])

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
