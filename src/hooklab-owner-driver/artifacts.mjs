// Hash-pinned ABI/profile loading. No RPC, keys or signing.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BorshCoder } from '@anchor-lang/core'
import { sha256, PROGRAMS, QUOTE_MINT, MAINNET_GENESIS, LOCAL_PROFILE_SCHEMA } from './pins.mjs'
import { productionProfileJson } from '../hooklab-production-operator-bundle.mjs'
import { parseStack } from '../hooklab-stack.mjs'
import { stackProductionArtifacts } from '../hooklab-production-stack-bundle.mjs'

// Rooted at the app directory (the web server runs there and Next traces these files; see next.config.mjs), falling
// back to this module's checkout for scripts run from elsewhere. (A static new URL('../../', import.meta.url) breaks
// the Next bundler, which treats it as a directory asset.)
const CANDIDATE = 'vendor/hooklab-event-abi/inclusive-max-wallet-candidate/'
function artifactRoot() {
  const roots = [process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')]
  const root = roots.find(dir => existsSync(path.join(dir, CANDIDATE, 'offline-builder-profile.json')))
  if (!root) throw Error('Pinned Hook Lab artifacts are not available')
  return root
}
export const PINNED_SHA256 = Object.freeze({
  profile: 'a7fd6e51ab08b7a15f4aea88a31665573efd1ba7d05a809aec2c46eb275523ce',
  launch: 'f3cb25209462044c139e8c81cf3d4fd28d2d4bd4023e265d4aaef78c9566fb8b',
  swap: '719b407b1f4ba90daa4770e6ab5b3e55b2dfe33f013b4b236ec72fb7b2134493',
  gate: 'fbcab6e26d3439c0b0afc3fb43a3afbab6c091ad11ba83cbfbefc11fab412b43',
  token: '93aaa54d2e0c22e444793ac84387c357d73b745d482becada32d7d6e23d2c506',
  bridge: '3cd2c95a14bfc0c2decd3bd0a6429044cbc7ca149f18e4c5c7c1d7d173b7732d',
})
export const ELF = Object.freeze({
  launch: { sha256: 'd4193f3634e68fb50c4bbfddc9ac2fc2e60f0ed2e1c6847c8a1580420875e9bb', length: 759976 },
  swap: { sha256: '3d5e1abee7fa2ff5f8d9a2b6c691b80849c75b298b4156f81d545dfa5f1caeaa', length: 554808 },
  gate: { sha256: 'd7233dd0fd23f58f2d1efec1543017395684f43827155e8b884a624c62493857', length: 188960 },
  token: { sha256: '7aa07deb41a5545bcaff0d3fb966d5344538ec8f5c9f2155db4de030e3255df1', length: 326504 },
})
export const FILES = {
  profile: `${CANDIDATE}offline-builder-profile.json`, launch: `${CANDIDATE}bordrless_launch.json`,
  swap: `${CANDIDATE}bordrless_swap.json`, gate: `${CANDIDATE}hook_max_wallet.json`,
  token: 'vendor/hooklab-production-candidate/idl/bordrless_token.json',
  bridge: 'vendor/hooklab-production-candidate/idl/bordrless_bridge.json',
}
let cached = null
export function loadArtifacts() {
  if (cached) return cached
  const text = {}, root = artifactRoot()
  for (const [role, file] of Object.entries(FILES)) {
    text[role] = readFileSync(path.join(root, file), 'utf8')
    if (sha256(text[role]) !== PINNED_SHA256[role]) throw Error(`Pinned ${role} artifact differs from reviewed bytes`)
  }
  const idls = Object.fromEntries(['launch', 'swap', 'gate', 'token', 'bridge'].map(role => [role, JSON.parse(text[role])]))
  for (const role of ['launch', 'swap', 'gate']) if (idls[role].address !== PROGRAMS[role]) throw Error(`IDL ${role} identity differs`)
  const profile = JSON.parse(text.profile)
  if (profile.genesisHash !== MAINNET_GENESIS || profile.quoteMint !== QUOTE_MINT
    || Object.entries(PROGRAMS).some(([role, address]) => profile.programs[role] !== address)) throw Error('Pinned profile identity differs')
  for (const role of ['launch', 'swap', 'gate']) if (profile.elfSha256[role] !== ELF[role].sha256) throw Error('Pinned ELF identity differs')
  const coders = Object.fromEntries(Object.entries(idls).map(([role, idl]) => [role, new BorshCoder(idl)]))
  cached = Object.freeze({ text, idls, coders, profile })
  return cached
}
// Compiler envelope: the reviewed profile plus the owner's fee and cap menus, byte-identical to the
// profile the production app serves customers. Local-test rebinds schema, id and genesis only.
export function compilerEnvelope({ genesisHash, providers, local }) {
  const { text, profile } = loadArtifacts(), production = productionProfileJson(profile)
  const json = local ? JSON.stringify({ ...JSON.parse(production), schema: LOCAL_PROFILE_SCHEMA, profileId: `local-owner-driver-${genesisHash.slice(0, 12)}`, genesisHash }) : production
  if (!local && genesisHash !== MAINNET_GENESIS) throw Error('Mainnet envelope requires the mainnet genesis')
  return Object.freeze({ json, expectedSha256: sha256(json),
    idls: Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, Buffer.from(text[role]).toString('base64')])),
    elfLengths: Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, ELF[role].length])),
    providers: [...providers] })
}
export const binding = role => { const { idls, coders } = loadArtifacts(); return { idl: idls[role], coder: coders[role] } }

// Our own stack (--stack FILE --stack-idls DIR): the stack's launch, swap and gate IDLs, each the exact bytes its build
// pins and naming the stack's program (src/hooklab-stack.mjs stackProfile checks both), and its builder profile. The
// token IDL is the vendored cross-network one (layout only; every token address comes from the stack). No bridge.
export const STACK_IDL_FILES = Object.freeze({ launch: 'bordrless_launch.json', swap: 'bordrless_swap.json', gate: 'hook_max_wallet.json' })
export function loadStackArtifacts(stackInput, idlDir) {
  const stack = parseStack(stackInput)
  if (!idlDir) throw Error('--stack needs --stack-idls DIR (the stack build\'s bordrless_launch.json, bordrless_swap.json, hook_max_wallet.json)')
  const bytes = Object.fromEntries(Object.entries(STACK_IDL_FILES).map(([role, file]) => [role, readFileSync(path.join(idlDir, file))]))
  const built = stackProductionArtifacts(stack, bytes), legacy = loadArtifacts()
  const idls = { launch: JSON.parse(bytes.launch), swap: JSON.parse(bytes.swap), gate: JSON.parse(bytes.gate), token: legacy.idls.token }
  const coders = Object.fromEntries(Object.entries(idls).map(([role, idl]) => [role, role === 'token' ? legacy.coders.token : new BorshCoder(idl)]))
  // ELF pins as a deployed ProgramData holds them: the trimmed bytes, then only zeros.
  const elf = Object.fromEntries(['launch', 'swap', 'gate', 'token'].map(role => [role, { sha256: stack.build.elf[role].trimmedSha256, length: stack.build.elf[role].trimmedLength }]))
  return Object.freeze({ stack, idls, coders, bytes, profile: built.base, elfLengths: built.elfLengths, elf })
}
// The stack's compiler envelope, as compilerEnvelope for bundle 2: its served profile (with the owner's menus); a local
// test rebinds schema, id and genesis only.
export function stackCompilerEnvelope(artifacts, { genesisHash, providers, local }) {
  const production = productionProfileJson(artifacts.profile)
  const json = local ? JSON.stringify({ ...JSON.parse(production), schema: LOCAL_PROFILE_SCHEMA, profileId: `local-owner-driver-${artifacts.stack.id}-${genesisHash.slice(0, 12)}`.slice(0, 64), genesisHash }) : production
  if (!local && genesisHash !== MAINNET_GENESIS) throw Error('Mainnet envelope requires the mainnet genesis')
  return Object.freeze({ json, expectedSha256: sha256(json),
    idls: Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, artifacts.bytes[role].toString('base64')])),
    elfLengths: { ...artifacts.elfLengths }, providers: [...providers] })
}
