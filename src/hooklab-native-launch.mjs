// Native-SOL launches (hook-lab feat/native-sol e357fdf, docs/native-sol-port-design.md §4-5): the launch Config's
// native-launches switch, the v4 economics hashes, the governed switch and the creator claim, the native flag bytes and
// the reviewed ELF pins a native profile carries. Pure: no RPC, keys or signing. Everything is behind
// HOOK_NATIVE_LAUNCHES_ENABLED, off by default.
import { createHash } from 'node:crypto'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_ELF, NATIVE_FLAGS, loadNativeArtifacts } from './hooklab-native-pins.mjs'
import { launchConfigReservedValid } from './hooklab-launch-config-reserved.mjs'

const check = (ok, message) => { if (!ok) throw Error(message) }
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest()
const kb = value => new PublicKey(value).toBuffer()
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new PublicKey(program))[0].toBase58()
const accountDisc = name => sha(`account:${name}`).subarray(0, 8)
// Anchor's instruction discriminator; computed, so importing this module never reads the vendored native files.
const instructionDisc = name => sha(`global:${name}`).subarray(0, 8)

export const NATIVE_LAUNCHES_FLAG = 'HOOK_NATIVE_LAUNCHES_ENABLED'
export const nativeLaunchesEnabled = (env = process.env) => env[NATIVE_LAUNCHES_FLAG] === 'true'
export const QUOTE_FORM_NATIVE = 1
export const LAUNCH_ACCOUNT_BYTES = 565
export const CREATE_LAUNCH_V3_DISCRIMINATOR = instructionDisc('create_launch_custom_v3')
export const CREATE_LAUNCH_V4_DISCRIMINATOR = instructionDisc('create_launch_custom_v4')

// Config.reserved[0] (byte 186). The rest of the reserved bytes hold open creation and its menus, or zero
// (src/hooklab-launch-config-reserved.mjs); anything else is not a state the reviewed programs write, so nothing is
// compiled or signed against it.
export function nativeLaunchesSwitch(configBytes) {
  const b = Buffer.from(configBytes), at = NATIVE_FLAGS.configNativeLaunches
  check(b.length === 250 && b.subarray(0, 8).equals(accountDisc('Config')), 'Not a launch Config account')
  if (!launchConfigReservedValid(b.subarray(at))) {
    check(b[at] === 0 || b[at] === 1, `Launch Config switch byte ${at} is ${b[at]}, not 0 or 1`)
    check(false, 'Launch Config reserved bytes after the switch are not a state the reviewed programs write')
  }
  return b[at] === 1
}

// v4 = sha256("hook-lab:create-{launch|pool}-economics:v4" || v3 hash || quote_form u8), for the launch and the pool guard.
export function nativeEconomicsHash(role, v3Digest, quoteForm = QUOTE_FORM_NATIVE) {
  check(role === 'launch' || role === 'pool', 'Unknown economics role')
  const v3 = Buffer.from(v3Digest)
  check(v3.length === 32, 'Expected a 32-byte v3 economics hash')
  check(quoteForm === 0 || quoteForm === 1, 'Unknown quote form')
  return sha(`hook-lab:create-${role}-economics:v4`, v3, [quoteForm])
}
// What governed_set_native_launches records as its policy change.
export const nativeLaunchesDigest = (launchProgram, config, on) => sha('hook-lab:native-launches:v1', kb(launchProgram), kb(config), [on ? 1 : 0])

// governed_set_native_launches(expected, on): the admin, against the full launch governance commitment.
export function governedSetNativeLaunches({ launchProgram, admin, expected, on }) {
  const commitment = Buffer.from(expected)
  check(commitment.length === 32, 'Expected a 32-byte governance commitment')
  check(on === true || on === false, 'on must be true or false')
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable })
  return new TransactionInstruction({ programId: new PublicKey(launchProgram),
    keys: [meta(admin, true, false), meta(pda(launchProgram, 'config'), false, true), meta(pda(launchProgram, 'governance'), false, true),
      meta(pda(launchProgram, '__event_authority'), false, false), meta(launchProgram, false, false)],
    data: loadNativeArtifacts().coders.launch.instruction.encode('governed_set_native_launches', { expected: [...commitment], on }) })
}
// claim_creator_fees_sol: the creator signs and is paid everything the launch account holds above its rent.
export function claimCreatorFeesSol({ launchProgram, creator, mint }) {
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable })
  return new TransactionInstruction({ programId: new PublicKey(launchProgram),
    keys: [meta(creator, true, true), meta(pda(launchProgram, 'launch', kb(mint)), false, true), meta(pda(launchProgram, '__event_authority'), false, false), meta(launchProgram, false, false)],
    data: loadNativeArtifacts().coders.launch.instruction.encode('claim_creator_fees_sol', {}) })
}

// The native flag of an account, at the offset its Option tag selects (the hook key is 32 bytes when present).
function flagAt(bytes, { name, length, tagAt, some, none }) {
  const b = Buffer.from(bytes)
  check(b.length === length && b.subarray(0, 8).equals(accountDisc(name)), `Not a ${name} account`)
  check(b[tagAt] === 0 || b[tagAt] === 1, `${name} option tag is not canonical`)
  const flag = b[b[tagAt] === 1 ? some : none]
  check(flag === 0 || flag === 1, `${name} native flag byte is not 0 or 1`)
  return flag === 1
}
export const launchIsNative = bytes => flagAt(bytes, { name: 'Launch', length: LAUNCH_ACCOUNT_BYTES, tagAt: 498, some: NATIVE_FLAGS.launch, none: NATIVE_FLAGS.launchWithoutHook })
export const poolIsNative = bytes => flagAt(bytes, { name: 'Pool', length: 411, tagAt: 171, some: NATIVE_FLAGS.pool, none: NATIVE_FLAGS.poolWithoutHook })

// A profile's ELF pin for the reviewed native build: the raw build output, or the trimmed bytes a deployed ProgramData holds.
export function isNativeElfPin(role, sha256, length) {
  const e = NATIVE_ELF[role]
  return !!e && ((sha256 === e.sha256 && length === e.length) || (sha256 === e.trimmedSha256 && length === e.trimmedLength))
}
// A ProgramData account (45-byte header) holding exactly the reviewed native ELF: its trimmed bytes, then only zeros.
export function nativeProgramDataMatches(role, programData) {
  const e = NATIVE_ELF[role], b = Buffer.from(programData)
  if (!e || b.length < 45 + e.trimmedLength || b.readUInt32LE(0) !== 3) return false
  return createHash('sha256').update(b.subarray(45, 45 + e.trimmedLength)).digest('hex') === e.trimmedSha256 && b.subarray(45 + e.trimmedLength).every(v => v === 0)
}
