// Chain-side truth for the assertions, read straight from the validator (not through the site): finalized transaction
// receipts, lamport deltas from pre/post balances, events decoded with the vendored native IDLs, and the Launch and Pool
// accounts with their native flag bytes. Independent of the site's own settlement code on purpose.
import { readFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey, SystemProgram, TransactionInstruction, VersionedMessage, type VersionedTransactionResponse } from '@solana/web3.js'
import bs58 from 'bs58'
import { connection, stack, until } from './stack.ts'

const vendor = (file: string) => JSON.parse(readFileSync(new URL(`../../../../vendor/${file}`, import.meta.url), 'utf8'))
export const PROGRAMS = { launch: 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft', swap: 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk', token: '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22' }
export const coders = { launch: new BorshCoder(vendor('hooklab-native-candidate/bordrless_launch.json')), swap: new BorshCoder(vendor('hooklab-native-candidate/bordrless_swap.json')) }
// Native flag bytes (hook-lab e357fdf): Launch.reserved[17] and Pool.reserved[0] for a coin with a hook.
export const FLAG = { launch: 560, pool: 351 }
const EMIT_CPI = Buffer.from('e445a52e51cb9a1d', 'hex')
const pda = (program: string, ...seeds: (string | Buffer)[]) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new PublicKey(program))[0].toBase58()
export const launchAddress = (mint: string) => pda(PROGRAMS.launch, 'launch', new PublicKey(mint).toBuffer())
export const holdingAddress = (mint: string, owner: string) => pda(PROGRAMS.token, 'holding', new PublicKey(mint).toBuffer(), new PublicKey(owner).toBuffer())
const tokenCoder = new BorshCoder(vendor('hooklab-production-candidate/idl/bordrless_token.json'))
/** The token program's permissionless create_holding: anyone may pay to create any owner's holding for a mint. */
export function createHoldingInstruction(payer: string, mint: string, owner: string): TransactionInstruction {
  const key = (address: string, isSigner = false, isWritable = false) => ({ pubkey: new PublicKey(address), isSigner, isWritable })
  return new TransactionInstruction({ programId: new PublicKey(PROGRAMS.token), data: tokenCoder.instruction.encode('create_holding', {}), keys: [
    key(payer, true, true), key(mint), key(owner), key(holdingAddress(mint, owner), false, true), key(SystemProgram.programId.toBase58()),
    key(pda(PROGRAMS.token, '__event_authority')), key(PROGRAMS.token)] })
}

export async function receipt(signature: string): Promise<VersionedTransactionResponse> {
  return until(`finalized receipt ${signature}`, () => connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }), { timeoutMs: 120_000 })
}
export function accountKeys(tx: VersionedTransactionResponse): string[] {
  return tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat().map(k => k.toBase58())
}
/** post − pre lamports of one account in one transaction (0n when the transaction does not touch it). */
export function lamportDelta(tx: VersionedTransactionResponse, address: string): bigint {
  const i = accountKeys(tx).indexOf(address)
  return i < 0 ? 0n : BigInt(tx.meta!.postBalances[i]) - BigInt(tx.meta!.preBalances[i])
}
export function allDeltas(tx: VersionedTransactionResponse): Record<string, string> {
  const keys = accountKeys(tx), out: Record<string, string> = {}
  keys.forEach((key, i) => { const d = BigInt(tx.meta!.postBalances[i]) - BigInt(tx.meta!.preBalances[i]); if (d !== 0n) out[key] = d.toString() })
  return out
}
export interface DecodedEvent { program: string; name: string; data: any }
/** Anchor emit_cpi events from the inner instructions of the launch and swap programs. */
export function events(tx: VersionedTransactionResponse): DecodedEvent[] {
  const keys = accountKeys(tx), out: DecodedEvent[] = []
  for (const group of tx.meta?.innerInstructions ?? []) for (const ix of group.instructions) {
    const program = keys[ix.programIdIndex], role = program === PROGRAMS.launch ? 'launch' : program === PROGRAMS.swap ? 'swap' : null
    if (!role) continue
    const bytes = Buffer.from(bs58.decode(ix.data))
    if (!bytes.subarray(0, 8).equals(EMIT_CPI)) continue
    const decoded = coders[role].events.decode(bytes.subarray(8).toString('base64'))
    if (decoded) out.push({ program: role, name: decoded.name, data: decoded.data })
  }
  return out
}
/** The launch- and swap-program instructions at the top level of the transaction, in order, as `role:name`. */
export function programInstructions(tx: VersionedTransactionResponse): string[] {
  const keys = accountKeys(tx)
  return tx.transaction.message.compiledInstructions.flatMap(ix => {
    const program = keys[ix.programIdIndex], role = program === PROGRAMS.launch ? 'launch' : program === PROGRAMS.swap ? 'swap' : null
    if (!role) return []
    const decoded = coders[role].instruction.decode(Buffer.from(ix.data))
    return [`${role}:${decoded?.name ?? 'unknown'}`]
  })
}
export const one = (list: DecodedEvent[], name: string) => {
  const found = list.filter(e => e.name === name)
  if (found.length !== 1) throw new Error(`expected exactly one ${name} event, found ${found.length}: ${list.map(e => e.name).join(', ')}`)
  return found[0].data
}
export const big = (value: { toString(): string }) => BigInt(value.toString())

/** Every signature in the transaction verifies over its message bytes (ed25519), and `signer` is one of the signers. */
export function verifySignatures(tx: VersionedTransactionResponse, signer: string): void {
  const message = Buffer.from((tx.transaction.message as VersionedMessage).serialize()), keys = accountKeys(tx)
  tx.transaction.signatures.forEach((signature, i) => {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(new PublicKey(keys[i]).toBytes()).toString('base64url') }, format: 'jwk' })
    if (!verify(null, message, key, Buffer.from(bs58.decode(signature)))) throw new Error(`signature ${i} of ${tx.transaction.signatures[0]} does not verify for ${keys[i]}`)
  })
  if (!keys.slice(0, tx.transaction.message.header.numRequiredSignatures).includes(signer)) throw new Error(`${signer} did not sign ${tx.transaction.signatures[0]}`)
}

export async function launchAccount(launch: string): Promise<{ raw: Buffer; value: any; lamports: bigint }> {
  const info = await connection.getAccountInfo(new PublicKey(launch), 'finalized')
  if (!info) throw new Error(`launch ${launch} missing`)
  return { raw: Buffer.from(info.data), value: coders.launch.accounts.decode('Launch', Buffer.from(info.data)), lamports: BigInt(info.lamports) }
}
export async function poolAccount(pool: string): Promise<{ raw: Buffer; value: any; lamports: bigint }> {
  const info = await connection.getAccountInfo(new PublicKey(pool), 'finalized')
  if (!info) throw new Error(`pool ${pool} missing`)
  return { raw: Buffer.from(info.data), value: coders.swap.accounts.decode('Pool', Buffer.from(info.data)), lamports: BigInt(info.lamports) }
}
/** Coin units the wallet holds (the token program's Holding.amount, u64 at byte 74). */
export async function coinBalance(mint: string, owner: string): Promise<bigint> {
  const info = await connection.getAccountInfo(new PublicKey(holdingAddress(mint, owner)), 'finalized')
  return info ? Buffer.from(info.data).readBigUInt64LE(74) : 0n
}
export const lamports = async (address: string) => BigInt(await connection.getBalance(new PublicKey(address), 'finalized'))
/** ⌈A·b/10⁴⌉, ⌊G/4⌋ and the creator's remainder: the inclusive creator-fee split, per swap. */
export function feeSplit(amount: bigint, bps: bigint) {
  const gross = (amount * bps + 9999n) / 10000n, platform = gross / 4n
  return { gross, platform, creator: gross - platform }
}
export { stack }
