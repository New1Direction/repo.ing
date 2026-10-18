// Keypair loading for execute only. Each path (typically a named pipe served by the owner's key
// tool) is read exactly once into memory, checked against the expected role address, and never
// logged, copied or written. Secrets are zeroed after signing.
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { ROLE_NAMES } from './pins.mjs'

const check = (ok, message) => { if (!ok) throw Error(message) }
export function parseKeyArgs(values) {
  const out = new Map()
  for (const value of values) {
    const at = value.indexOf('='), role = value.slice(0, at), path = value.slice(at + 1)
    check(at > 0 && path.length > 0, `--key expects ROLE=PATH (got a malformed value for ${at > 0 ? role : 'an unnamed role'})`)
    check(ROLE_NAMES.includes(role), `Unknown key role ${role}`)
    check(!out.has(role), `Duplicate --key for role ${role}`)
    out.set(role, path)
  }
  return out
}
function readSecretOnce(path) {
  const bytes = readFileSync(path)
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { bytes.fill(0); throw Error('Key source is not a JSON keypair array') }
  bytes.fill(0)
  check(Array.isArray(parsed) && parsed.length === 64 && parsed.every(n => Number.isInteger(n) && n >= 0 && n < 256), 'Key source is not a 64-byte keypair array')
  const secret = Uint8Array.from(parsed); parsed.fill(0)
  return secret
}
/** Load exactly the keys for `required` signer addresses. `roles` maps role -> expected address. */
export function loadSigners(keyArgs, roles, required) {
  const byAddress = new Map(Object.entries(roles).filter(([, a]) => a).map(([role, address]) => [address, role]))
  const needed = required.map(address => { const role = byAddress.get(address); check(role, `Required signer ${address} is not a known role`); return role })
  for (const role of keyArgs.keys()) check(needed.includes(role), `--key ${role} is not required by this message; refusing extra key material`)
  for (const role of needed) check(keyArgs.has(role), `Missing --key ${role}=PATH (required signer ${roles[role]})`)
  const signers = []
  try {
    for (const role of needed) {
      const secret = readSecretOnce(keyArgs.get(role))
      let keypair
      // Keypair keeps a reference to `secret`; wipe() zeroes it after signing.
      try { keypair = Keypair.fromSecretKey(secret) } catch { secret.fill(0); throw Error(`Key for role ${role} is not a valid ed25519 keypair`) }
      if (keypair.publicKey.toBase58() !== roles[role]) { wipe([keypair]); throw Error(`Key for role ${role} does not match the expected address ${roles[role]}`) }
      signers.push(keypair)
    }
  } catch (error) { wipe(signers); throw error }
  return signers
}
export function wipe(signers) {
  for (const s of signers) { try { s._keypair?.secretKey?.fill(0) } catch { /* best effort */ } }
}
