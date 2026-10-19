// The settlement the site persisted (hook_lab_native_signing_operations.first_finalized) must be this exact receipt.
import { expect } from 'e2e'
import type { VersionedTransactionResponse } from '@solana/web3.js'
import type { OperationRow } from './db.ts'
import { allDeltas } from './chain.ts'

export function expectSettlementIsReceipt(op: OperationRow, tx: VersionedTransactionResponse, accrued?: { gross: bigint; platform: bigint; creator: bigint }): void {
  const stored = op.first_finalized
  expect(op.status).toBe('finalized-success')
  expect(op.first_conflict).toBeNull()
  expect(stored?.status).toBe('finalized-success')
  expect(stored?.signature).toBe(tx.transaction.signatures[0])
  expect(op.signature).toBe(tx.transaction.signatures[0])
  expect(stored?.messageSha256).toBe(op.message_sha256)
  if (stored?.inclusion?.slot !== undefined) expect(Number(stored.inclusion.slot)).toBe(tx.slot)
  if (stored?.feeLamports !== undefined) expect(String(stored.feeLamports)).toBe(String(tx.meta!.fee))
  if (accrued && stored?.quote) {
    expect([stored.quote.grossCreatorFee, stored.quote.protocolFee, stored.quote.netCreatorFee].map(String))
      .toEqual([accrued.gross, accrued.platform, accrued.creator].map(String))
  }
  // Every lamport delta the site recorded is the chain's own pre/post balance difference.
  if (stored?.lamportDeltas) {
    const chain = allDeltas(tx)
    for (const [address, delta] of Object.entries(stored.lamportDeltas)) expect(`${address}:${chain[address] ?? '0'}`).toBe(`${address}:${delta}`)
  }
}
