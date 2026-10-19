// The program sets a local stack can load: which ELF goes to which program ID, each ELF sha256-checked against its pin
// in code, plus the quote mint and (legacy only) the production bridge. The IDs are data, so a set at other IDs (the
// independent stack) loads the same way; every set refuses to start unless each ELF is exactly its pinned build.
//   native-e357fdf      the reviewed native-SOL launch/swap (E1/E2), at the legacy IDs, synthetic quote marker at A49o
//   native-open-36dd07e the open-creation launch (self-serve; swap/gate/token unchanged), at the legacy IDs
//   legacy-bundle-2     what mainnet runs today: the bundle-2 launch/swap, the max-wallet gate and token at E73/B2/BdAa/
//                       2XoE, the production bridge CtLk and the bridged-SOL mint A49o from a public mainnet snapshot
//   independent         the new stack of our own: token, gate, launch and swap at their NEW program IDs and the
//                       quote-marker mint, read from the independent deploy kit's public manifest (HOOKLAB_INDEPENDENT_DIR,
//                       stack.public.json + quote-marker.fixture.json); a rehearsal stand-in kit is refused unless
//                       HOOKS_E2E_ALLOW_REHEARSAL=1 (its launch and swap are built for the old IDs and cannot run)
// The ELFs are private (never in this repository); the bridge snapshot is public mainnet account data.
import { readFileSync, readdirSync, statSync } from 'node:fs'
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
// The independent stack's placeholder IDs (hook-lab feat/independent-stack, relayed 2026-10-19). A kit or build folder that
// names other IDs is accepted only as the deploy kit's rehearsal (HOOKS_E2E_ALLOW_REHEARSAL=1).
export const INDEPENDENT_IDS = Object.freeze({ token: 'Hd8ZnPitqn25jJd7bnsvAm16NAbyuBqsAt4PSisCHw61', gate: '2SXqMdMajvHb8oHXw8saTTizUnDJBHD2cVFQhsKTnJGQ',
  launch: 'AbDhG5aFs7hSkYZ71MZ2dZkaMbMhohiKgLpepDenQ2w1', swap: '9HsALDF9rYPbm6TC9XBJR6mP5v9yHoUn9GA4HHMHNWEC', quoteMint: '2JTTrekMSkwF3B83LVroiKPVxauUwAJR1xtQs4CJoGVc' })
// HOOKLAB_INDEPENDENT_DIR, else the newest hooks-local-state/independent-<sha> build folder, else the deploy kit.
function independentDir() {
  if (process.env.HOOKLAB_INDEPENDENT_DIR) return process.env.HOOKLAB_INDEPENDENT_DIR
  const builds = readdirSync(HOOKS_LOCAL_STATE).filter(name => /^independent-[0-9a-f]{7,40}$/.test(name)).map(name => path.join(HOOKS_LOCAL_STATE, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return builds[0] ?? path.join(HOOKS_LOCAL_STATE, 'independent-deploy-kit')
}
const MARKER_LAMPORTS = (128 + 519) * 3480 * 2 // rent-exempt minimum of the 519-byte Mint

/** The legacy stack's identities: no transaction of the new (independent) stack may invoke these programs or name the mint. */
export const LEGACY_STACK = Object.freeze({
  programs: Object.freeze({ token: PROGRAMS.token, bridge: PROGRAMS.bridge, launch: PROGRAMS.launch, swap: PROGRAMS.swap, gate: PROGRAMS.gate }),
  quoteMint: QUOTE_MINT,
})

const SETS = {
  'native-e357fdf': () => ({ ids: LEGACY_IDS, quoteMint: QUOTE_MINT, bundle: { build: 'e357fdf' }, bridge: false,
    elfs: { launch: [NATIVE_ELF_DIR, NATIVE_ELF.launch], swap: [NATIVE_ELF_DIR, NATIVE_ELF.swap], gate: [NATIVE_ELF_DIR, ELF.gate], token: [NATIVE_ELF_DIR, ELF.token] } }),
  'native-open-36dd07e': () => ({ ids: LEGACY_IDS, quoteMint: QUOTE_MINT, bundle: { build: 'open-36dd07e' }, bridge: false,
    elfs: { launch: [OPEN_ELF_DIR, OPEN_ELF.launch], swap: [OPEN_ELF_DIR, OPEN_ELF.swap], gate: [NATIVE_ELF_DIR, ELF.gate], token: [NATIVE_ELF_DIR, ELF.token] } }),
  'legacy-bundle-2': () => ({ ids: LEGACY_IDS, quoteMint: QUOTE_MINT, bundle: { build: 'bundle-2' }, bridge: true,
    elfs: { launch: [BUNDLE2_ELF_DIR, ELF.launch], swap: [BUNDLE2_ELF_DIR, ELF.swap], gate: [BUNDLE2_ELF_DIR, ELF.gate], token: [BUNDLE2_ELF_DIR, ELF.token] } }),
}
export const PROGRAM_SET_NAMES = Object.freeze([...Object.keys(SETS), 'independent'])

/** The independent stack from its deploy kit's public manifest: each ELF checked against the manifest's sha256 and length
 * (the kit itself is review-hashed by its owner), and the quote-marker mint as the exact account the kit's create_mint
 * produces (owner = our token program, no authorities), its creation time zero. */
function independentSet() {
  const INDEPENDENT_DIR = independentDir()
  const manifest = JSON.parse(readFileSync(path.join(INDEPENDENT_DIR, 'stack.public.json'), 'utf8'))
  if (manifest.schema !== 'hook-lab/independent-deploy-kit/stack/1') throw Error(`independent: unknown kit manifest ${manifest.schema}`)
  if (manifest.status !== 'final' && process.env.HOOKS_E2E_ALLOW_REHEARSAL !== '1') throw Error(`independent: the kit is "${manifest.status}", not final (HOOKS_E2E_ALLOW_REHEARSAL=1 boots it for a smoke test only)`)
  const elfs = Object.fromEntries(['token', 'gate', 'launch', 'swap'].map(role => {
    const entry = manifest.programs.find(p => p.name === role)
    if (!entry) throw Error(`independent: the manifest has no ${role} program`)
    const where = path.join(INDEPENDENT_DIR, entry.elf), bytes = readFileSync(where), digest = sha256(bytes)
    if (digest !== entry.sha256 || bytes.length !== entry.length) throw Error(`independent: ${role} ELF ${where} is ${digest} (${bytes.length} bytes), not the manifest's ${entry.sha256} (${entry.length})`)
    if (Object.values(LEGACY_STACK.programs).includes(entry.address)) throw Error(`independent: ${role} uses a legacy program ID`)
    return [role, { path: where, sha256: digest, programId: entry.address }]
  }))
  const ids = Object.freeze(Object.fromEntries(Object.entries(elfs).map(([role, e]) => [role, e.programId])))
  const placeholder = ['token', 'gate', 'launch', 'swap'].every(role => ids[role] === INDEPENDENT_IDS[role]) && manifest.quoteMarker.address === INDEPENDENT_IDS.quoteMint
  if (!placeholder && process.env.HOOKS_E2E_ALLOW_REHEARSAL !== '1') throw Error(`independent: ${INDEPENDENT_DIR} names other IDs than the independent stack's (${JSON.stringify(ids)})`)
  const fixtureText = readFileSync(path.join(INDEPENDENT_DIR, manifest.quoteMarker.fixture), 'utf8')
  if (sha256(fixtureText) !== manifest.quoteMarker.fixtureSha256) throw Error('independent: the quote-marker fixture differs from its manifest hash')
  const fixture = JSON.parse(fixtureText), expected = fixture.expected
  if (expected.account !== manifest.quoteMarker.address || expected.owner !== ids.token || expected.space !== 519) throw Error('independent: the quote-marker fixture names another account, owner or size')
  if (expected.account === QUOTE_MINT) throw Error('independent: the quote marker is the legacy mint')
  const data = Buffer.from(expected.dataHex, 'hex')
  for (const [from, to] of expected.mask ?? []) data.fill(0, from, to) // the creation time, set by the program
  const marker = { pubkey: expected.account, account: { lamports: MARKER_LAMPORTS, data: [data.toString('base64'), 'base64'], owner: ids.token, executable: false, rentEpoch: 0 } }
  return Object.freeze({ name: 'independent', ids, quoteMint: expected.account, bundle: { build: 'independent' }, elfs, bridge: null,
    status: manifest.status, genesis: { marker } })
}

/** A program set with every ELF checked against its pin (sha256 and length). Throws naming the first mismatch. */
export function programSet(name) {
  if (name === 'independent') return independentSet()
  if (!Object.hasOwn(SETS, name)) throw Error(`unknown program set ${name}; known: ${PROGRAM_SET_NAMES.join(', ')}`)
  const set = SETS[name]()
  const elfs = Object.fromEntries(Object.entries(set.elfs).map(([role, [dir, pin]]) => {
    const where = path.join(dir, FILES[role]), bytes = readFileSync(where), digest = sha256(bytes)
    if (digest !== pin.sha256 || bytes.length !== pin.length) throw Error(`${name}: ${role} ELF ${where} is sha256 ${digest} (${bytes.length} bytes), not the pinned ${pin.sha256} (${pin.length})`)
    return [role, { path: where, sha256: digest, programId: set.ids[role] }]
  }))
  return Object.freeze({ name, ids: set.ids, quoteMint: set.quoteMint, bundle: set.bundle, elfs, bridge: set.bridge ? bridgeSnapshot() : null })
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
