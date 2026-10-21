// Server-retained supplemental table creation and immutable account validation.
// No signer, sender, RPC discovery or production authority is provided here.
import { isDeepStrictEqual } from 'node:util'
import { AddressLookupTableProgram, AddressLookupTableAccount, PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress, hookRawAmount } from './hooklab-execution-contract.mjs'
const check = (v, message = 'Supplemental launch table differs') => { if (!v) throw Error(message) }
const pk = v => new PublicKey(v)
export const supplementalTableSchema = z.object({ address: hookAddress, recentSlot: z.number().int().nonnegative().safe(),
  addresses: z.array(hookAddress).min(1).max(64).refine(a => new Set(a).size === a.length), rentLamports: hookRawAmount.refine(v => BigInt(v) > 0n) }).strict()
export function supplementalTableInstructions(creator, value) {
  const t = supplementalTableSchema.parse(value), authority = pk(creator)
  const [create, address] = AddressLookupTableProgram.createLookupTable({ authority, payer: authority, recentSlot: t.recentSlot })
  check(address.toBase58() === t.address && !t.addresses.includes(t.address) && !t.addresses.includes(creator))
  return [create, AddressLookupTableProgram.extendLookupTable({ authority, payer: authority, lookupTable: address, addresses: t.addresses.map(pk) }),
    AddressLookupTableProgram.freezeLookupTable({ authority, lookupTable: address })]
}
export function assertFrozenSupplementalTable(account, expected, slot, { warmed = false } = {}) {
  const t = supplementalTableSchema.parse(expected), b = Buffer.from(account?.dataBase64 ?? '', 'base64')
  check(account?.address === t.address && account.owner === AddressLookupTableProgram.programId.toBase58() && account.executable === false
    && b.toString('base64') === account.dataBase64 && b.length === 56 + 32 * t.addresses.length && b.readUInt32LE() === 1
    && b[21] === 0 && b.subarray(22, 56).every(v => v === 0) && BigInt(account.lamports) >= BigInt(t.rentLamports))
  const s = AddressLookupTableAccount.deserialize(b)
  check(s.deactivationSlot === 0xffffffffffffffffn && s.lastExtendedSlot >= t.recentSlot
    && (warmed ? s.lastExtendedSlot < slot : s.lastExtendedSlot <= slot)
    && s.lastExtendedSlotStartIndex === 0 && isDeepStrictEqual(s.addresses.map(k => k.toBase58()), t.addresses))
  return s
}
