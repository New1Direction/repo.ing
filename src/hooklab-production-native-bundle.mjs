// Bundle 3: the production operator bundle for a reviewed native-SOL build of launch and swap: hook-lab feat/native-sol
// e357fdf, or the open-creation build (feat/open-creation 36dd07e: only the launch program differs, adding self-serve
// launches). It pins that build's IDLs and the trimmed ELF hashes a deployed ProgramData holds; the gate, token, quote
// mint, program IDs and creator menus are bundle 2's. An open-creation bundle also pins the owner's shared launch table.
// Its preview reads the two programs from both providers and refuses unless each holds the chosen build, so before the
// mainnet upgrade it says the programs are not upgraded yet. Read-only: no keys, signing or sending.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_BUILDS, NATIVE_FILES, NATIVE_SOURCE, OPEN_FILES_LIST, loadNativeArtifacts, loadOpenArtifacts } from './hooklab-native-pins.mjs'
import { PRODUCTION_NETWORK, collectProductionOperatorBundle, productionArtifacts, readBoth } from './hooklab-production-operator-bundle.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const refuse = message => { throw Object.assign(Error(`Production bundle refused: ${message}`), { code: 'PRODUCTION_BUNDLE_REFUSED' }) }
const need = (ok, message) => { if (!ok) refuse(message) }
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const ROLES = Object.freeze(['launch', 'swap'])
const repoFile = file => readFileSync(new URL(`../${file}`, import.meta.url))

export const NATIVE_SOURCE_COMMIT = 'e357fdf4a5be0d8baa360ec82028441d298b925b'
// The native builds come from the commit as is (its tree has the inclusive-fees feature), so no patch: sha256 of nothing.
export const NO_SOURCE_PATCH_SHA256 = sha('')

// The vendored files each build's bundle names: the IDLs and vectors (its "SDK").
const BUILD_FILES = Object.freeze({ e357fdf: { files: NATIVE_FILES, launchIdl: 'vendor/hooklab-native-candidate/bordrless_launch.json', commit: NATIVE_SOURCE_COMMIT, load: loadNativeArtifacts },
  'open-36dd07e': { files: OPEN_FILES_LIST, launchIdl: 'vendor/hooklab-native-candidate/open-36dd07e/bordrless_launch.json', commit: NATIVE_BUILDS['open-36dd07e'].source.commit, load: loadOpenArtifacts } })
export const NATIVE_BUNDLE_BUILDS = Object.freeze(Object.keys(BUILD_FILES))

export function nativeProductionArtifacts(inclusive = productionArtifacts(), { build = 'e357fdf' } = {}) {
  need(Object.hasOwn(BUILD_FILES, build), `unknown native build ${build}; known: ${NATIVE_BUNDLE_BUILDS.join(', ')}`)
  const pins = NATIVE_BUILDS[build], files = BUILD_FILES[build]
  need(NATIVE_SOURCE_COMMIT.startsWith(NATIVE_SOURCE.commit) && files.commit.startsWith(pins.source.commit.slice(0, 7)), 'native source commit differs from the reviewed pin')
  files.load() // the vendored files carry their reviewed bytes
  const idls = { ...inclusive.idls, launch: repoFile(files.launchIdl), swap: repoFile('vendor/hooklab-native-candidate/bordrless_swap.json') }
  for (const role of ROLES) need(sha(idls[role]) === pins.idlSha256[role], `native ${role} IDL differs from its reviewed pin`)
  const pick = field => Object.fromEntries(ROLES.map(role => [role, pins.elf[role][field]]))
  const base = { ...inclusive.base, profileId: `native-sol-${files.commit.slice(0, 12)}`, sourceCommit: files.commit,
    sourcePatchSha256: NO_SOURCE_PATCH_SHA256, idlSha256: { ...inclusive.base.idlSha256, ...pins.idlSha256 },
    elfSha256: { ...inclusive.base.elfSha256, ...pick('trimmedSha256') } }
  // The native "SDK" is the vendored candidate itself: the build's IDLs and instruction vectors.
  const sdkSha256 = sha(JSON.stringify(files.files.map(file => [file, sha(repoFile(file))])))
  return { base, idls, elfLengths: { ...inclusive.elfLengths, ...pick('trimmedLength') }, sdkSha256, build }
}

// A ProgramData account holding exactly this build's trimmed ELF for the role, then only zeros.
function holdsBuild(role, b, build) {
  const e = NATIVE_BUILDS[build]?.elf[role]
  return !!e && b.length >= 45 + e.trimmedLength && b.readUInt32LE(0) === 3 && sha(b.subarray(45, 45 + e.trimmedLength)) === e.trimmedSha256 && b.subarray(45 + e.trimmedLength).every(v => v === 0)
}
// Which reviewed build a launch or swap ProgramData holds: 'native' (the chosen build's trimmed bytes, then zeros),
// 'bundle-2', or 'unknown' (anything else, another native build included).
export function deployedBuild(role, programData, inclusive = productionArtifacts(), build = 'e357fdf') {
  const b = Buffer.from(programData), length = inclusive.elfLengths[role]
  if (holdsBuild(role, b, build)) return 'native'
  const bundle2 = b.length >= 45 + length && b.readUInt32LE(0) === 3 && sha(b.subarray(45, 45 + length)) === inclusive.base.elfSha256[role]
    && b.subarray(45 + length).every(v => v === 0)
  return bundle2 ? 'bundle-2' : 'unknown'
}

export function requireNativeBuilds(builds) {
  const unknown = ROLES.find(role => builds[role] === 'unknown' || !['native', 'bundle-2'].includes(builds[role]))
  if (unknown) refuse(`${unknown} deployed code is neither the reviewed native build nor the bundle-2 build; do not build bundle 3`)
  const old = ROLES.filter(role => builds[role] === 'bundle-2')
  if (old.length === ROLES.length) refuse('programs not upgraded yet: launch and swap still run the bundle-2 build; upgrade both to the reviewed native build first')
  if (old.length) refuse(`programs not upgraded yet: ${old[0]} still runs the bundle-2 build (${ROLES.find(r => r !== old[0])} is native); finish the upgrade first`)
}

// Reads launch and swap ProgramData from both providers (identical bytes required) on the expected network and refuses
// unless both hold the reviewed native build.
export async function previewNativeBundle({ connections, network = PRODUCTION_NETWORK, build = 'e357fdf' }) {
  need(Array.isArray(connections) && connections.length === 2, 'two providers required')
  need((await Promise.all(connections.map(c => c.connection.getGenesisHash()))).every(g => g === network.genesisHash), 'a provider is on another network')
  const addresses = ROLES.map(role => PublicKey.findProgramAddressSync([new PublicKey(productionArtifacts().base.programs[role]).toBuffer()], new PublicKey(LOADER))[0].toBase58())
  const observed = await readBoth(connections, addresses)
  const programs = ROLES.map((role, i) => {
    const bytes = observed[i].data, e = NATIVE_BUILDS[build].elf[role]
    need(observed[i].owner === LOADER && bytes.length >= 45 && bytes.readUInt32LE(0) === 3, `${role} program data is not an upgradeable-loader program`)
    return { role, programData: addresses[i], build: deployedBuild(role, bytes, productionArtifacts(), build), deploySlot: Number(bytes.readBigUInt64LE(4)),
      upgradeAuthority: bytes[12] ? new PublicKey(bytes.subarray(13, 45)).toBase58() : null,
      trimmedSha256: bytes.length >= 45 + e.trimmedLength ? sha(bytes.subarray(45, 45 + e.trimmedLength)) : null, expectedTrimmedSha256: e.trimmedSha256 }
  })
  requireNativeBuilds(Object.fromEntries(programs.map(p => [p.role, p.build])))
  return { genesisHash: network.genesisHash, programs }
}

// The preview, then bundle 3 itself (the collector re-checks every pin, the gate, the configs and the trade table).
export async function collectNativeProductionBundle(options) {
  const preview = await previewNativeBundle(options)
  const bundle = await collectProductionOperatorBundle({ ...options, artifacts: nativeProductionArtifacts(productionArtifacts(), { build: options.build ?? 'e357fdf' }) })
  return { preview, bundle }
}
