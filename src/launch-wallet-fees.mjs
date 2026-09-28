import { ComputeBudgetProgram } from '@solana/web3.js'

// Phantom adds priority-fee instructions to unsigned transactions without an
// explicit compute budget. Set it before review so the quoted message stays
// unchanged during wallet signing. Zero price preserves existing launch fees.
export function setLaunchWalletFees(transaction) {
  if (transaction.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))) {
    throw new Error('Launch compute budget must be set exactly once')
  }
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
  )
  return transaction
}
