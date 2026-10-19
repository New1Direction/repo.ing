// The reviewed native-SOL builds of the Hook Lab swap and launch programs (hook-lab feat/native-sol), not yet on
// mainnet: their IDLs and vectors (each checked against its pinned sha256 when loaded), ELF hashes, the flag bytes the
// native code reads, and an error decoder. No RPC, keys or signing.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BorshCoder } from '@anchor-lang/core'
import { sha256, PROGRAMS } from './hooklab-owner-driver/pins.mjs'

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
  for (const role of ['swap', 'launch']) if (idls[role].address !== PROGRAMS[role]) throw Error(`Native IDL ${role} identity differs`)
  cached = Object.freeze({ idls, coders: { swap: new BorshCoder(idls.swap), launch: new BorshCoder(idls.launch) }, vectors: JSON.parse(text.vectors) })
  return cached
}

// The error's name for this program, or null. Codes are per program: QuoteFormMismatch is 6106 in launch, 6113 in swap.
export function nativeErrorName(programId, code) {
  const role = programId === PROGRAMS.swap ? 'swap' : programId === PROGRAMS.launch ? 'launch' : null
  return role ? loadNativeArtifacts().idls[role].errors?.find(error => error.code === code)?.name ?? null : null
}
