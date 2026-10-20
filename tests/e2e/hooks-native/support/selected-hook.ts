// Each fixture hook's own public registry interface. This is a creator's
// external registry preparation, NOT a substitute for the application's config
// preparation / launch signing lifecycle. Only synthetic faucet-funded keys.
import { createHash } from 'node:crypto'
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, type Keypair, type VersionedTransactionResponse } from '@solana/web3.js'
import { expect } from 'e2e'
import { connection, stack } from './stack.ts'
import { accountKeys } from './chain.ts'

export const selected = () => {
  if (stack.mode !== 'selected-hook' || !stack.selectedHook) throw Error('This suite requires explicit selected-hook acceptance mode')
  if (!['127.0.0.1', 'localhost'].includes(new URL(stack.validator.url).hostname)) throw Error('Selected fixture requires loopback validator')
  return stack.selectedHook
}
const isReceipt = () => selected().source === 'programs/transfer_receipt_hook/src/lib.rs'
const address = (mint: string, seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed), new PublicKey(mint).toBuffer()], new PublicKey(selected().pin.program))[0]
export const scriptAddress = (mint: string) => address(mint, isReceipt() ? 'receipts' : 'script')
export const registryAddress = (mint: string) => address(mint, 'bordrless-hook-accounts')

export async function initializeSelectedRegistry(creator: Keypair, mint: string): Promise<string> {
  selected()
  const key = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })
  const instruction = new TransactionInstruction({ programId: new PublicKey(selected().pin.program), keys: [
    key(creator.publicKey, true, true), key(new PublicKey(mint)), key(scriptAddress(mint), true), key(registryAddress(mint), true), key(SystemProgram.programId),
  ], data: isReceipt() ? createHash('sha256').update('global:prepare').digest().subarray(0, 8)
    : Buffer.concat([createHash('sha256').update('global:init_script').digest().subarray(0, 8), Buffer.alloc(4)]) }) // test-only empty extras Vec
  return sendAndConfirmTransaction(connection, new Transaction().add(instruction), [creator], { commitment: 'finalized' })
}

export async function scriptCalls(mint: string): Promise<bigint> {
  const info = await connection.getAccountInfo(scriptAddress(mint), 'finalized')
  expect(info?.owner.toBase58()).toBe(selected().pin.program)
  // Receipt: discriminator, version, bump, pinned token, mint, calls (u64).
  // Test Script: discriminator, version, bump, authority, key, calls (u64).
  if (isReceipt()) expect(info!.data.length).toBe(82)
  return Buffer.from(info!.data).readBigUInt64LE(74)
}

export function expectSelectedInvoked(tx: VersionedTransactionResponse) {
  const hook = selected().pin.program, keys = accountKeys(tx)
  expect(tx.meta?.err).toBeNull()
  expect(keys.includes(hook)).toBe(true)
  const invoked = (tx.meta?.innerInstructions ?? []).flatMap(group => group.instructions.map(ix => keys[ix.programIdIndex]))
  expect(invoked.includes(hook)).toBe(true)
  expect(invoked.includes(stack.programs!.gate)).toBe(false)
}
