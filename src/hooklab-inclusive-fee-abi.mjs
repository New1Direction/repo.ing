// Explicit V3 source ABI helpers. These do not authenticate deployment or construct authorization.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
const check = (ok, message) => { if (!ok) throw Error(message) }
const kb = key => new PublicKey(key).toBuffer()
const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest()
const disc = name => hash(Buffer.from(`account:${name}`)).subarray(0, 8)
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
const vec = value => { const b = Buffer.from(value); return Buffer.concat([u32(b.length), b]) }
const modeShare = Buffer.from([2, 0xc4, 9])
export function inclusiveFeePolicyAddress(swapProgram, pool) {
  return PublicKey.findProgramAddressSync([Buffer.from('inclusive-fee-policy'), kb(pool)], new PublicKey(swapProgram))[0].toBase58()
}
export function inclusiveMaxWalletPolicyAddress(gateProgram, mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('policy-v2'), kb(mint)], new PublicKey(gateProgram))[0].toBase58()
}
export function inclusivePolicyMeta(swapProgram, pool, operation) {
  check(['create', 'swap', 'collect'].includes(operation), 'UNSUPPORTED_OPERATION')
  return Object.freeze({ address: inclusiveFeePolicyAddress(swapProgram, pool), signer: false, writable: operation === 'create' })
}
export function readInclusiveFeePolicy(account, swapProgram, pool) {
  const bytes = Buffer.from(account.data)
  check(account.address === inclusiveFeePolicyAddress(swapProgram, pool) && account.owner === swapProgram
    && account.executable === false && account.signer === false && account.writable === false, 'INCLUSIVE_POLICY_IDENTITY')
  check(bytes.length === 75 && bytes.subarray(0, 8).equals(disc('InclusiveFeePolicy')) && bytes[8] === 1
    && bytes.subarray(9, 41).equals(kb(pool)) && bytes.readUInt16LE(73) === 2500, 'INCLUSIVE_POLICY_BYTES')
  return Object.freeze({ version: 1, pool, collector: new PublicKey(bytes.subarray(41, 73)).toBase58(), protocolShareBps: 2500 })
}
export function inclusiveEconomicsHash(role, v2Digest) {
  check(role === 'launch' || role === 'pool', 'INVALID_ECONOMICS_ROLE')
  const bytes = Buffer.from(v2Digest)
  check(bytes.length === 32, 'INVALID_V2_DIGEST')
  return hash(Buffer.from(`hook-lab:create-${role}-economics:v3`), bytes, modeShare)
}
export function inclusiveHookAccountsHash({ program, registry, policy, launch }) {
  check(Buffer.from(registry.data).length <= 256 && Buffer.from(policy.data).length === 90, 'HOOK_ACCOUNT_LENGTH')
  return hash(Buffer.from('hook-lab:inclusive-hook-accounts:v3'), kb(program), kb(registry.address), kb(registry.owner), vec(registry.data),
    kb(policy.address), kb(policy.owner), vec(policy.data), kb(launch.address), kb(launch.owner), modeShare)
}
