// Our own stack for tests, until the independent-stack build (hook-lab feat/independent-stack) exists: the reviewed ELFs
// (open-creation launch and swap, 36dd07e; the deployed gate and token) relocated to fresh program IDs. Every 32-byte
// occurrence of a legacy program ID and of the kit, and the launch code's one precomputed address (the token program's
// signer for the kit), is replaced; the IDLs are renamed to match; the quote marker is a fresh mint. Any legacy address
// left in the native and open lifecycle therefore breaks the tests that use it. Test data only: no production pins.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import { LEGACY_STACK, parseStack } from '../../src/hooklab-stack.mjs'
import { OPEN_ELF, OPEN_SOURCE } from '../../src/hooklab-native-pins.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest()
const hex = bytes => sha(bytes).toString('hex')
const state = path.join(homedir(), 'Documents/ChatGPT/hooks-local-state')
const OPEN_DIR = process.env.HOOKLAB_OPEN_ELF_DIR ?? path.join(state, 'native-open-36dd07e/elf')
const NATIVE_DIR = process.env.HOOKLAB_NATIVE_ELF_DIR ?? path.join(state, 'native-e357fdf')
export const OWN_STACK_SOURCES = Object.freeze({
  launch: path.join(OPEN_DIR, 'bordrless_launch.so'), swap: path.join(OPEN_DIR, 'bordrless_swap.so'),
  gate: path.join(NATIVE_DIR, 'hook_max_wallet.so'), token: path.join(NATIVE_DIR, 'bordrless_token.so') })
// The legacy bytes each relocated ELF must start from (the open launch; every other program as deployed or e357fdf's swap).
const SOURCE_SHA256 = Object.freeze({ launch: OPEN_ELF.launch.sha256, swap: OPEN_ELF.swap.sha256,
  gate: 'd7233dd0fd23f58f2d1efec1543017395684f43827155e8b884a624c62493857', token: '7aa07deb41a5545bcaff0d3fb966d5344538ec8f5c9f2155db4de030e3255df1' })
const IDL_FILES = Object.freeze({ launch: '../../vendor/hooklab-native-candidate/open-36dd07e/bordrless_launch.json',
  swap: '../../vendor/hooklab-native-candidate/bordrless_swap.json', gate: '../../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/hook_max_wallet.json' })
export const OWN_STACK_SKIP = Object.values(OWN_STACK_SOURCES).some(file => !existsSync(file))
  && process.env.HOOKLAB_CANARY_REQUIRED !== 'true' && 'the reviewed ELFs (HOOKLAB_OPEN_ELF_DIR, HOOKLAB_NATIVE_ELF_DIR) are not available'

// hook-lab feat/independent-stack's PLACEHOLDER IDs (ids/independent.json; throwaway, never mainnet). The kit stays the
// legacy kit ID; the token program's signer for it is derived under our token.
export const PLACEHOLDER_IDS = Object.freeze({ token: 'Hd8ZnPitqn25jJd7bnsvAm16NAbyuBqsAt4PSisCHw61', gate: '2SXqMdMajvHb8oHXw8saTTizUnDJBHD2cVFQhsKTnJGQ',
  launch: 'AbDhG5aFs7hSkYZ71MZ2dZkaMbMhohiKgLpepDenQ2w1', swap: '9HsALDF9rYPbm6TC9XBJR6mP5v9yHoUn9GA4HHMHNWEC',
  quoteMint: '2JTTrekMSkwF3B83LVroiKPVxauUwAJR1xtQs4CJoGVc', upgradeAuthority: '9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md' })
const key = (seed, role) => Keypair.fromSeed(sha(`repo.ing own stack test v1 ${seed} ${role}`)).publicKey.toBase58()
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new PublicKey(program))[0]
// SBF code holds an address both as 32 contiguous bytes (read-only data) and as four 64-bit lddw immediates (each split
// in two 32-bit halves 8 bytes apart). Both forms are rewritten; any legacy chunk left over fails the relocation.
function relocate(bytes, pairs) {
  const out = Buffer.from(bytes), chunks = new Map()
  for (const [from, to] of pairs) {
    for (let at = out.indexOf(from); at !== -1; at = out.indexOf(from, at + 32)) to.copy(out, at)
    for (let i = 0; i < 4; i++) chunks.set(from.readBigUInt64LE(8 * i), to.readBigUInt64LE(8 * i))
  }
  for (let at = 0; at + 16 <= out.length; at += 8) {
    if (out[at] !== 0x18 || out[at + 8] !== 0) continue
    const imm = BigInt(out.readUInt32LE(at + 4)) | (BigInt(out.readUInt32LE(at + 12)) << 32n), to = chunks.get(imm)
    if (to === undefined) continue
    out.writeUInt32LE(Number(to & 0xffffffffn), at + 4); out.writeUInt32LE(Number(to >> 32n), at + 12)
  }
  return out
}
function survives(bytes, pairs) {
  const legacy = new Set(pairs.filter(([from, to]) => !from.equals(to)).flatMap(([from]) => [0, 1, 2, 3].map(i => from.readBigUInt64LE(8 * i))))
  if (pairs.some(([from, to]) => !from.equals(to) && bytes.indexOf(from) !== -1)) return true
  for (let at = 0; at + 16 <= bytes.length; at += 8) if (bytes[at] === 0x18 && bytes[at + 8] === 0 && legacy.has(BigInt(bytes.readUInt32LE(at + 4)) | (BigInt(bytes.readUInt32LE(at + 12)) << 32n))) return true
  return false
}
const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
// Every address the reviewed code computes at compile time: the programs, the bridged-SOL mint (our marker takes its
// place), the bridge (absent from our stack: moved to an unused address) and each program's fixed PDAs.
function addressPairs(from, to) {
  const roles = Object.keys(from), pairs = roles.map(role => [from[role], to[role]])
  for (const role of roles) {
    for (const seed of ['config', 'governance', '__event_authority', 'hook-authority', 'sol-vault']) pairs.push([pda(from[role], seed), pda(to[role], seed)])
    for (const other of roles) pairs.push([pda(from[role], 'hook-authority', new PublicKey(from[other]).toBuffer()), pda(to[role], 'hook-authority', new PublicKey(to[other]).toBuffer())])
    pairs.push([pda(from[role], 'wrapper', new PublicKey(NATIVE_MINT).toBuffer()), pda(to[role], 'wrapper', new PublicKey(NATIVE_MINT).toBuffer())])
  }
  return pairs.map(([a, b]) => [new PublicKey(a).toBuffer(), new PublicKey(b).toBuffer()]).filter(([a, b]) => !a.equals(b))
}
const trim = bytes => { let end = bytes.length; while (end > 0 && bytes[end - 1] === 0) end--; return bytes.subarray(0, end) }

// The reviewed code also holds each fixed PDA's bump as a compile-time constant (event authorities, hook signers), which
// relocation cannot rewrite. So the relocated IDs are ground until every such PDA keeps its legacy bump; hook-lab's real
// placeholder IDs (PLACEHOLDER_IDS) need their own build and are used where no ELF runs.
const bump = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new PublicKey(program))[1]
const PROGRAM_ROLES = ['launch', 'gate', 'swap', 'token']
// The fixed PDAs compiled into the reviewed ELFs (an lddw scan of all four), per program: [seed, other program].
const COMPILED_PDAS = Object.freeze({ launch: [['__event_authority'], ['hook-authority'], ['config']], gate: [['__event_authority']],
  swap: [['__event_authority'], ['config'], ['hook-authority', 'launch']], token: [['__event_authority'], ['hook-authority', 'kit']] })
function groundIds(seed, kit) {
  const legacy = { ...LEGACY_STACK.programs, kit: LEGACY_STACK.kitProgram }, chosen = { kit }
  const seedsOf = (ids, [s, other]) => other ? [s, new PublicKey(ids[other]).toBuffer()] : [s]
  for (const role of PROGRAM_ROLES) {
    const wanted = COMPILED_PDAS[role].map(p => [p, bump(legacy[role], ...seedsOf(legacy, p))])
    for (let i = 0; ; i++) {
      if (i > 20000) throw Error(`No ${role} ID keeps the legacy bumps`)
      chosen[role] = key(seed, `${role}-${i}`)
      if (wanted.every(([p, b]) => bump(chosen[role], ...seedsOf(chosen, p)) === b)) break
    }
  }
  return Object.fromEntries(PROGRAM_ROLES.map(role => [role, chosen[role]]))
}
// Fresh IDs ground from seed (and a fresh kit with freshKit), relocated onto, and a fresh quote marker. upgradeAuthority:
// the synthetic key the test bank's ProgramData names. Returns the stack descriptor (as the owner would review it) and the
// relocated ELFs and IDLs.
export function ownStack({ seed = 'a', freshKit = false, upgradeAuthority = PLACEHOLDER_IDS.upgradeAuthority } = {}) {
  const kit = freshKit ? key(seed, 'kit') : LEGACY_STACK.kitProgram, legacy = LEGACY_STACK.programs
  const programs = groundIds(seed, kit), ids = { ...programs, quoteMint: key(seed, 'quoteMint') }
  const from = { ...Object.fromEntries(['launch', 'swap', 'gate', 'token'].map(role => [role, legacy[role]])), kit: LEGACY_STACK.kitProgram, quote: LEGACY_STACK.quoteMint, bridge: legacy.bridge }
  const to = { ...programs, kit, quote: ids.quoteMint, bridge: key(seed, 'retired-bridge') }
  const binary = addressPairs(from, to)
  const elfs = Object.fromEntries(Object.entries(OWN_STACK_SOURCES).map(([role, file]) => {
    const source = readFileSync(file)
    if (hex(source) !== SOURCE_SHA256[role]) throw Error(`The ${role} ELF to relocate is not the reviewed one`)
    const out = relocate(source, binary)
    if (survives(out, binary)) throw Error(`A legacy address survived relocation in ${role}`)
    return [role, out]
  }))
  const idls = Object.fromEntries(Object.entries(IDL_FILES).map(([role, file]) => {
    // The IDLs name the same addresses (programs and fixed PDAs, e.g. the token's kit signer placeholder) in base58.
    const text = binary.map(([a, b]) => [new PublicKey(a).toBase58(), new PublicKey(b).toBase58()]).reduce((value, [a, b]) => value.split(a).join(b), readFileSync(new URL(file, import.meta.url), 'utf8'))
    return [role, Buffer.from(text)]
  }))
  const pin = role => { const t = trim(elfs[role]); return { trimmedSha256: hex(t), trimmedLength: t.length } }
  const stack = parseStack({ schema: 'repoing/hooks-stack/1', id: `test-${seed}`, status: 'placeholder', programs, quoteMint: ids.quoteMint, upgradeAuthority, kitProgram: kit,
    build: { name: 'relocated-open-36dd07e', source: { repo: OPEN_SOURCE.repo, branch: 'feat/open-creation relocated for tests', commit: OPEN_SOURCE.commit },
      elf: Object.fromEntries(['launch', 'swap', 'gate', 'token'].map(role => [role, pin(role)])),
      idlSha256: Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, hex(idls[role])])), open: true } })
  return { stack, elfs, idls }
}

// hook-lab feat/independent-stack's own build (no relocation), as tests/fixtures/hooklab-independent-stack.mjs finds it.
export { INDEPENDENT_DIR, INDEPENDENT_SKIP, independentStack } from './hooklab-independent-stack.mjs'
