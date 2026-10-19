// The program sets a local stack can load: which ELF goes to which program ID, each ELF sha256-checked against its pin
// in code, plus the quote mint and (legacy only) the production bridge. The IDs are data, so programs at other IDs load
// the same way; every set refuses to start unless each ELF is exactly its pinned build.
//   native-e357fdf      the reviewed native-SOL launch/swap (E1/E2), at the legacy IDs, synthetic quote marker at A49o
//   native-open-36dd07e the open-creation launch (swap/gate/token unchanged), at the legacy IDs
//   legacy-bundle-2     what mainnet runs today: the bundle-2 launch/swap, the max-wallet gate and token at E73/B2/BdAa/
//                       2XoE, the production bridge CtLk and the bridged-SOL mint A49o from a public mainnet snapshot
// and, beside the legacy set, our own stack (ownStackSet): token, gate, launch and swap at their NEW program IDs and our
// own quote-marker mint, from hook-lab's independent build.
// The ELFs are private (never in this repository); the bridge snapshot is public mainnet account data.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_ELF, OPEN_ELF } from '../../../src/hooklab-native-pins.mjs'
import { ELF } from '../../../src/hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS, QUOTE_MINT } from '../../../src/hooklab-owner-driver/pins.mjs'
import { HOOKS_LOCAL_STATE, NATIVE_ELF_DIR, REPO_ROOT, sha256 } from './common.mjs'

export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const FILES = { launch: 'bordrless_launch.so', swap: 'bordrless_swap.so', gate: 'hook_max_wallet.so', token: 'bordrless_token.so' }
const LEGACY_IDS = Object.freeze({ launch: PROGRAMS.launch, swap: PROGRAMS.swap, gate: PROGRAMS.gate, token: PROGRAMS.token })
const OPEN_ELF_DIR = process.env.HOOKLAB_OPEN_ELF_DIR ?? path.join(HOOKS_LOCAL_STATE, 'native-open-36dd07e', 'elf')
const BUNDLE2_ELF_DIR = process.env.HOOKLAB_BUNDLE2_ELF_DIR ?? path.join(HOOKS_LOCAL_STATE, 'rebuilt-inclusive', 'elf')

/** The legacy stack's identities: no transaction of the new stack may invoke these programs or name the mint. */
export const LEGACY_STACK = Object.freeze({
  programs: Object.freeze({ token: PROGRAMS.token, bridge: PROGRAMS.bridge, launch: PROGRAMS.launch, swap: PROGRAMS.swap, gate: PROGRAMS.gate }),
  quoteMint: QUOTE_MINT,
})
// The independent stack's placeholder IDs (hook-lab feat/independent-stack ids/independent.json, relayed 2026-10-19). Our
// own stack must be at exactly these until the owner's final keys exist.
export const INDEPENDENT_IDS = Object.freeze({ token: 'Hd8ZnPitqn25jJd7bnsvAm16NAbyuBqsAt4PSisCHw61', gate: '2SXqMdMajvHb8oHXw8saTTizUnDJBHD2cVFQhsKTnJGQ',
  launch: 'AbDhG5aFs7hSkYZ71MZ2dZkaMbMhohiKgLpepDenQ2w1', swap: '9HsALDF9rYPbm6TC9XBJR6mP5v9yHoUn9GA4HHMHNWEC', quoteMint: '2JTTrekMSkwF3B83LVroiKPVxauUwAJR1xtQs4CJoGVc' })

const SETS = {
  'native-e357fdf': () => ({ ids: LEGACY_IDS, quoteMint: QUOTE_MINT, bundle: { build: 'e357fdf' }, bridge: false,
    elfs: { launch: [NATIVE_ELF_DIR, NATIVE_ELF.launch], swap: [NATIVE_ELF_DIR, NATIVE_ELF.swap], gate: [NATIVE_ELF_DIR, ELF.gate], token: [NATIVE_ELF_DIR, ELF.token] } }),
  'native-open-36dd07e': () => ({ ids: LEGACY_IDS, quoteMint: QUOTE_MINT, bundle: { build: 'open-36dd07e' }, bridge: false,
    elfs: { launch: [OPEN_ELF_DIR, OPEN_ELF.launch], swap: [OPEN_ELF_DIR, OPEN_ELF.swap], gate: [NATIVE_ELF_DIR, ELF.gate], token: [NATIVE_ELF_DIR, ELF.token] } }),
  'legacy-bundle-2': () => ({ ids: LEGACY_IDS, quoteMint: QUOTE_MINT, bundle: { build: 'bundle-2' }, bridge: true,
    elfs: { launch: [BUNDLE2_ELF_DIR, ELF.launch], swap: [BUNDLE2_ELF_DIR, ELF.swap], gate: [BUNDLE2_ELF_DIR, ELF.gate], token: [BUNDLE2_ELF_DIR, ELF.token] } }),
}
export const PROGRAM_SET_NAMES = Object.freeze(Object.keys(SETS))

/** A program set with every ELF checked against its pin (sha256 and length). Throws naming the first mismatch. */
export function programSet(name) {
  if (!Object.hasOwn(SETS, name)) throw Error(`unknown program set ${name}; known: ${PROGRAM_SET_NAMES.join(', ')}`)
  const set = SETS[name]()
  const elfs = Object.fromEntries(Object.entries(set.elfs).map(([role, [dir, pin]]) => {
    const where = path.join(dir, FILES[role]), bytes = readFileSync(where), digest = sha256(bytes)
    if (digest !== pin.sha256 || bytes.length !== pin.length) throw Error(`${name}: ${role} ELF ${where} is sha256 ${digest} (${bytes.length} bytes), not the pinned ${pin.sha256} (${pin.length})`)
    return [role, { path: where, sha256: digest, programId: set.ids[role] }]
  }))
  return Object.freeze({ name, ids: set.ids, quoteMint: set.quoteMint, bundle: set.bundle, elfs, bridge: set.bridge ? bridgeSnapshot() : null })
}

/** Our own stack (the new coins' stack): hook-lab's independent build at its placeholder IDs, read with the site's own
 * reader (src/hooklab-stack-build.mjs checks every ELF against the build's ELF-HASHES.txt), or, with HOOKS_E2E_OWN_STACK=relocated, the reviewed open-creation
 * ELFs relocated onto those IDs (tests/fixtures/hooklab-own-stack.mjs). The ELF bytes stay in memory and in the stack's
 * temporary root. The upgrade authority is the stack's synthetic upgrade role. */
// The independent build the suite runs on: the final program build, hook-lab e775165 (the coordinator's pick,
// 2026-10-19); HOOKLAB_INDEPENDENT_DIR overrides it.
export const INDEPENDENT_BUILD_DIR = process.env.HOOKLAB_INDEPENDENT_DIR ?? path.join(HOOKS_LOCAL_STATE, 'independent-e775165')
export async function ownStackSet({ upgradeAuthority }) {
  const relocated = process.env.HOOKS_E2E_OWN_STACK === 'relocated'
  process.env.HOOKLAB_INDEPENDENT_DIR = INDEPENDENT_BUILD_DIR // read by the fixture when it loads
  const built = relocated ? (await import('../../../tests/fixtures/hooklab-own-stack.mjs')).ownStack({ upgradeAuthority })
    : (await import('../../../tests/fixtures/hooklab-independent-stack.mjs')).independentStack({ upgradeAuthority })
  const { stack } = built, ids = { ...stack.programs, quoteMint: stack.quoteMint }
  const wrong = Object.entries(INDEPENDENT_IDS).filter(([role, id]) => ids[role] !== id).map(([role]) => role)
  if (wrong.length) throw Error(`our own stack is not at the independent placeholder IDs (${wrong.join(', ')})`)
  if (Object.values(stack.programs).some(id => Object.values(LEGACY_STACK.programs).includes(id)) || stack.quoteMint === LEGACY_STACK.quoteMint) throw Error('our own stack reuses a legacy identity')
  const elfSha256 = Object.fromEntries(Object.entries(built.elfs).map(([role, bytes]) => [role, sha256(bytes)]))
  return Object.freeze({ name: relocated ? 'own-relocated' : stack.build.name, stack, elfs: built.elfs, elfSha256, idls: built.idls, ids: stack.programs, quoteMint: stack.quoteMint })
}

/** The public mainnet bridge snapshot as validator genesis rows: the program account (pointing at its program data), the
 * program data verbatim except its deploy slot (set to 0 so the program is callable from slot 1 on a fresh validator; the
 * code and the mainnet upgrade authority, which BRIDGE_PIN checks, are unchanged), and the config, wrapper, vault and
 * bridged-SOL mint verbatim. */
export function bridgeSnapshot() {
  const snapshot = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests/e2e/hooks-native/snapshot/bridge.json'), 'utf8'))
  const row = (pubkey, { lamports, data, owner, executable }) => ({ pubkey, account: { lamports: Number(lamports), data: [Buffer.from(data).toString('base64'), 'base64'], owner, executable, rentEpoch: 0 } })
  const rows = snapshot.accounts.map(a => {
    const data = Buffer.from(a.dataBase64, 'base64')
    if (sha256(data) !== a.sha256) throw Error(`bridge snapshot ${a.role} differs from its recorded sha256`)
    if (a.role === 'bridge-program-data') data.writeBigUInt64LE(0n, 4)
    return row(a.address, { lamports: a.lamports, data, owner: a.owner, executable: a.executable })
  })
  const programData = snapshot.accounts.find(a => a.role === 'bridge-program-data').address
  const program = Buffer.alloc(36); program.writeUInt32LE(2, 0); new PublicKey(programData).toBuffer().copy(program, 4)
  rows.unshift(row(snapshot.bridgeProgram, { lamports: 1141440, data: program, owner: LOADER, executable: true }))
  return { slot: snapshot.source.slot, rows }
}
