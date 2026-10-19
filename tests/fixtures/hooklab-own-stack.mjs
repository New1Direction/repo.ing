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
function replaceAll(bytes, from, to) {
  const out = Buffer.from(bytes)
  for (let at = out.indexOf(from); at !== -1; at = out.indexOf(from, at + to.length)) to.copy(out, at)
  return out
}
const trim = bytes => { let end = bytes.length; while (end > 0 && bytes[end - 1] === 0) end--; return bytes.subarray(0, end) }

// The placeholder IDs by default; seed: a distinct stack of fresh IDs and a fresh kit instead (for two-stack tests).
// upgradeAuthority: the synthetic key the test bank's ProgramData names. Returns the stack descriptor (as the owner would
// review it) and the relocated ELFs and IDLs.
export function ownStack({ seed = null, upgradeAuthority = PLACEHOLDER_IDS.upgradeAuthority } = {}) {
  const ids = seed ? Object.fromEntries(['launch', 'swap', 'gate', 'token', 'quoteMint'].map(role => [role, key(seed, role)])) : PLACEHOLDER_IDS
  const programs = Object.fromEntries(['launch', 'swap', 'gate', 'token'].map(role => [role, ids[role]]))
  const kit = seed ? key(seed, 'kit') : LEGACY_STACK.kitProgram, legacy = LEGACY_STACK.programs
  const pairs = [...['launch', 'swap', 'gate', 'token'].map(role => [legacy[role], programs[role]]), ...(kit === LEGACY_STACK.kitProgram ? [] : [[LEGACY_STACK.kitProgram, kit]])]
  const binary = [...pairs.map(([from, to]) => [new PublicKey(from).toBuffer(), new PublicKey(to).toBuffer()]),
    [pda(legacy.token, 'hook-authority', new PublicKey(LEGACY_STACK.kitProgram).toBuffer()).toBuffer(), pda(programs.token, 'hook-authority', new PublicKey(kit).toBuffer()).toBuffer()]]
  const elfs = Object.fromEntries(Object.entries(OWN_STACK_SOURCES).map(([role, file]) => {
    const source = readFileSync(file)
    if (hex(source) !== SOURCE_SHA256[role]) throw Error(`The ${role} ELF to relocate is not the reviewed one`)
    const out = binary.reduce((bytes, [from, to]) => replaceAll(bytes, from, to), source)
    for (const [from, to] of binary) if (!from.equals(to) && out.indexOf(from) !== -1) throw Error(`A legacy address survived relocation in ${role}`)
    return [role, out]
  }))
  const idls = Object.fromEntries(Object.entries(IDL_FILES).map(([role, file]) => {
    const text = pairs.reduce((value, [from, to]) => value.split(from).join(to), readFileSync(new URL(file, import.meta.url), 'utf8'))
    return [role, Buffer.from(text)]
  }))
  const pin = role => { const t = trim(elfs[role]); return { trimmedSha256: hex(t), trimmedLength: t.length } }
  const stack = parseStack({ schema: 'repoing/hooks-stack/1', id: `test-${seed ?? 'placeholder'}`, status: 'placeholder', programs, quoteMint: ids.quoteMint, upgradeAuthority, kitProgram: kit,
    build: { name: 'relocated-open-36dd07e', source: { repo: OPEN_SOURCE.repo, branch: 'feat/open-creation relocated for tests', commit: OPEN_SOURCE.commit },
      elf: Object.fromEntries(['launch', 'swap', 'gate', 'token'].map(role => [role, pin(role)])),
      idlSha256: Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, hex(idls[role])])), open: true } })
  return { stack, elfs, idls }
}
