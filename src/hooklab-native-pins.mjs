// The reviewed native-SOL builds of the Hook Lab swap and launch programs (hook-lab feat/native-sol), not yet on
// mainnet: their IDLs and vectors (each checked against its pinned sha256 when loaded), ELF hashes, the flag bytes the
// native code reads, and an error decoder. No RPC, keys or signing.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BorshCoder } from '@anchor-lang/core'
import { sha256 } from './hooklab-owner-driver/pins.mjs'
import { LEGACY_STACK } from './hooklab-stack.mjs'

export const NATIVE_SOURCE = Object.freeze({ repo: 'New1Direction/hook-lab', branch: 'feat/native-sol', commit: 'e357fdf' })
// Raw build output and the trimmed bytes a deployed ProgramData holds (trailing zeros removed), as the upgrade checks.
export const NATIVE_ELF = Object.freeze({
  swap: Object.freeze({ length: 613136, sha256: '35e231338971fa71b9ca0717f2476e0a4be2ea0e2ee844ca5b0553a66c2b4ab8',
    trimmedLength: 613121, trimmedSha256: '85e178c3730fabf54031df220af65cc14e9bfd2b85566368152727cf381db438' }),
  launch: Object.freeze({ length: 798576, sha256: '7c5d880f55106e5e9318a90c013f7b9aa8a9e23c0c5abec57f618bbe83fd9121',
    trimmedLength: 798561, trimmedSha256: 'acbd9a6060fb2a86e93b54a2c637dca2d9a59dfca770edf2857e662213d48547' }),
})
// Byte offsets of the native flags: Pool.reserved[0] (a pool without a hook is 32 bytes shorter), Launch.reserved[17]
// (likewise) and the launch Config's native-launches switch, Config.reserved[0].
export const NATIVE_FLAGS = Object.freeze({ pool: 351, poolWithoutHook: 319, launch: 560, launchWithoutHook: 528, configNativeLaunches: 186 })

const DIRECTORY = 'vendor/hooklab-native-candidate/'
const FILES = Object.freeze({ swap: 'bordrless_swap.json', launch: 'bordrless_launch.json', vectors: 'native-v4-vectors.json' })
export const NATIVE_FILES = Object.freeze(Object.values(FILES).map(file => `${DIRECTORY}${file}`))
const PINNED_SHA256 = Object.freeze({
  swap: '6ed76cb7a544e8e39666e632cef4f7bad86fb41fd354d6812bc6a5bb07407733',
  launch: '060f233d3d6c9fbb144279b985e62049a3098109c68d3bd231598fdd48e969b4',
  vectors: 'c731bf277a51ec3c4ffaec9367b5482555915250154852e0879716ede9274afb',
})
// What a native profile pins for the two IDLs (the vendored files' bytes).
export const NATIVE_IDL_SHA256 = Object.freeze({ swap: PINNED_SHA256.swap, launch: PINNED_SHA256.launch })

// Rooted at the app directory like the owner driver's artifacts (src/hooklab-owner-driver/artifacts.mjs).
function nativeRoot() {
  const roots = [process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')]
  const root = roots.find(dir => existsSync(path.join(dir, DIRECTORY, FILES.swap)))
  if (!root) throw Error('Pinned native Hook Lab artifacts are not available')
  return root
}

let cached = null
export function loadNativeArtifacts() {
  if (cached) return cached
  const root = nativeRoot(), text = {}
  for (const [role, file] of Object.entries(FILES)) {
    text[role] = readFileSync(path.join(root, DIRECTORY, file), 'utf8')
    if (sha256(text[role]) !== PINNED_SHA256[role]) throw Error(`Pinned native ${role} artifact differs from reviewed bytes`)
  }
  const idls = { swap: JSON.parse(text.swap), launch: JSON.parse(text.launch) }
  // The vendored e357fdf IDLs name the legacy programs they were reviewed for. Their coders serve any stack (account and
  // event layouts do not depend on the program ID); every compiler checks the profile's own IDL bytes and identity.
  for (const role of ['swap', 'launch']) if (idls[role].address !== LEGACY_STACK.programs[role]) throw Error(`Native IDL ${role} identity differs`)
  cached = Object.freeze({ idls, coders: { swap: new BorshCoder(idls.swap), launch: new BorshCoder(idls.launch) }, vectors: JSON.parse(text.vectors) })
  return cached
}

// The error's name for this program, or null. Codes are per program: QuoteFormMismatch is 6106 in launch, 6113 in swap.
// The open-creation launch IDL is a superset of e357fdf's, so it also names the open-launch errors (6120..6124).
export function nativeErrorName(programId, code, programs) {
  const role = programId === programs?.swap ? 'swap' : programId === programs?.launch ? 'launch' : null
  return role ? loadOpenArtifacts().idls[role].errors?.find(error => error.code === code)?.name ?? null : null
}

// The open-creation build (hook-lab feat/open-creation 36dd07e, on top of e357fdf): only the launch program changed (it
// adds create_launch_open_v1 and governed_set_open_creation); the swap, gate and token ELFs and the swap IDL are e357fdf's.
// A second pin set beside e357fdf's, so a bundle can name either build until the release decision is final.
export const OPEN_SOURCE = Object.freeze({ repo: 'New1Direction/hook-lab', branch: 'feat/open-creation', commit: '36dd07e881c7eb39000b92d4c2699997d3a24e33',
  base: 'e357fdf4a5be0d8baa360ec82028441d298b925b' })
export const OPEN_ELF = Object.freeze({
  launch: Object.freeze({ length: 824544, sha256: '44cbcbf2cb5192ec05f88a6b267263d1b4e8f77c7a159d103ffe216cd2952650',
    trimmedLength: 824529, trimmedSha256: '673d3e3e2657baf4ffdb386d9eeb92e18c7f7328e868df9e61adbf09a0b782ab' }),
  swap: NATIVE_ELF.swap,
})
const OPEN_DIRECTORY = 'vendor/hooklab-native-candidate/open-36dd07e/'
const OPEN_FILES = Object.freeze({ launch: 'bordrless_launch.json', live: 'open-live-vectors.json', vectors: 'open-creation-vectors.production.json' })
const OPEN_PINNED_SHA256 = Object.freeze({
  launch: 'eded394457b3c1490aa67a252807996f5388b59bc9e53bbbef49739f5b216fe8',
  live: 'f7cafd2db87efaf940866fcfe947e0d75a39f798a1f977b7adc799bce88fe63f',
  vectors: '71785f196022b09af10578c46eff57efe3f411597f74977df5fc7007d90521f8',
})
export const OPEN_FILES_LIST = Object.freeze([...Object.values(OPEN_FILES).map(file => `${OPEN_DIRECTORY}${file}`), `${DIRECTORY}${FILES.swap}`])
export const OPEN_IDL_SHA256 = Object.freeze({ swap: PINNED_SHA256.swap, launch: OPEN_PINNED_SHA256.launch })
let openCached = null
// The open build's IDLs (its launch IDL, e357fdf's swap IDL) and vectors, each checked against its pinned bytes. Program
// identities are checked where they are used, against the bundle's profile, never against constants here.
export function loadOpenArtifacts() {
  if (openCached) return openCached
  const root = nativeRoot(), text = {}
  for (const [name, file] of Object.entries(OPEN_FILES)) {
    text[name] = readFileSync(path.join(root, OPEN_DIRECTORY, file), 'utf8')
    if (sha256(text[name]) !== OPEN_PINNED_SHA256[name]) throw Error(`Pinned open-creation ${name} artifact differs from reviewed bytes`)
  }
  const idls = { swap: loadNativeArtifacts().idls.swap, launch: JSON.parse(text.launch) }
  openCached = Object.freeze({ idls, coders: { swap: loadNativeArtifacts().coders.swap, launch: new BorshCoder(idls.launch) }, live: JSON.parse(text.live), vectors: JSON.parse(text.vectors) })
  return openCached
}
// Every reviewed native build, by name: its ELF pins and IDL pins.
export const NATIVE_BUILDS = Object.freeze({
  e357fdf: Object.freeze({ source: NATIVE_SOURCE, elf: NATIVE_ELF, idlSha256: NATIVE_IDL_SHA256 }),
  'open-36dd07e': Object.freeze({ source: OPEN_SOURCE, elf: OPEN_ELF, idlSha256: OPEN_IDL_SHA256 }),
})
const elfMatches = (e, sha, length) => !!e && ((sha === e.sha256 && length === e.length) || (sha === e.trimmedSha256 && length === e.trimmedLength))
// The reviewed native build whose launch and swap ELF and IDL pins this profile names (raw or trimmed ELF), or null. Both
// programs must name the same build: an e357fdf launch with the open IDL, or the reverse, is no build.
export function nativeBuildOf(profile, elfLengths) {
  const name = Object.keys(NATIVE_BUILDS).find(build => ['launch', 'swap'].every(role => elfMatches(NATIVE_BUILDS[build].elf[role], profile?.elfSha256?.[role], elfLengths?.[role])
    && profile?.idlSha256?.[role] === NATIVE_BUILDS[build].idlSha256[role]))
  return name ?? null
}
// The build one program's pins name (ELF and IDL of the same build), or null.
export function nativeBuildForRole(role, { elfSha256, elfLength, idlSha256 }) {
  return Object.keys(NATIVE_BUILDS).find(build => elfMatches(NATIVE_BUILDS[build].elf[role], elfSha256, elfLength) && NATIVE_BUILDS[build].idlSha256[role] === idlSha256) ?? null
}
export const isReviewedNativeElf = (role, sha, length) => Object.values(NATIVE_BUILDS).some(build => elfMatches(build.elf[role], sha, length))
