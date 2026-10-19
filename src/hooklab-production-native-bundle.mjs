// Bundle 3: the production operator bundle for the reviewed native-SOL builds of launch and swap (hook-lab
// feat/native-sol e357fdf). It pins the native IDLs and the trimmed ELF hashes a deployed ProgramData holds; the gate,
// token, quote mint, program IDs and creator menus are bundle 2's. Its preview reads the two programs from both providers
// and refuses unless each holds the reviewed native build, so before the mainnet upgrade it says the programs are not
// upgraded yet. Read-only: no keys, signing or sending.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_ELF, NATIVE_FILES, NATIVE_IDL_SHA256, NATIVE_SOURCE, loadNativeArtifacts } from './hooklab-native-pins.mjs'
import { nativeProgramDataMatches } from './hooklab-native-launch.mjs'
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

export function nativeProductionArtifacts(inclusive = productionArtifacts()) {
  need(NATIVE_SOURCE_COMMIT.startsWith(NATIVE_SOURCE.commit), 'native source commit differs from the reviewed pin')
  loadNativeArtifacts() // the vendored native files carry their reviewed bytes and name the production programs
  const idls = { ...inclusive.idls }
  for (const role of ROLES) {
    idls[role] = repoFile(`vendor/hooklab-native-candidate/bordrless_${role}.json`)
    need(sha(idls[role]) === NATIVE_IDL_SHA256[role], `native ${role} IDL differs from its reviewed pin`)
  }
  const pick = field => Object.fromEntries(ROLES.map(role => [role, NATIVE_ELF[role][field]]))
  const base = { ...inclusive.base, profileId: `native-sol-${NATIVE_SOURCE_COMMIT.slice(0, 12)}`, sourceCommit: NATIVE_SOURCE_COMMIT,
    sourcePatchSha256: NO_SOURCE_PATCH_SHA256, idlSha256: { ...inclusive.base.idlSha256, ...NATIVE_IDL_SHA256 },
    elfSha256: { ...inclusive.base.elfSha256, ...pick('trimmedSha256') } }
  // The native "SDK" is the vendored candidate itself: both IDLs and the instruction vectors.
  const sdkSha256 = sha(JSON.stringify(NATIVE_FILES.map(file => [file, sha(repoFile(file))])))
  return { base, idls, elfLengths: { ...inclusive.elfLengths, ...pick('trimmedLength') }, sdkSha256 }
}

// Which reviewed build a launch or swap ProgramData holds: 'native' (trimmed bytes, then zeros), 'bundle-2', or 'unknown'.
export function deployedBuild(role, programData, inclusive = productionArtifacts()) {
  const b = Buffer.from(programData), length = inclusive.elfLengths[role]
  if (nativeProgramDataMatches(role, b)) return 'native'
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
export async function previewNativeBundle({ connections, network = PRODUCTION_NETWORK }) {
  need(Array.isArray(connections) && connections.length === 2, 'two providers required')
  need((await Promise.all(connections.map(c => c.connection.getGenesisHash()))).every(g => g === network.genesisHash), 'a provider is on another network')
  const addresses = ROLES.map(role => PublicKey.findProgramAddressSync([new PublicKey(productionArtifacts().base.programs[role]).toBuffer()], new PublicKey(LOADER))[0].toBase58())
  const observed = await readBoth(connections, addresses)
  const programs = ROLES.map((role, i) => {
    const bytes = observed[i].data, e = NATIVE_ELF[role]
    need(observed[i].owner === LOADER && bytes.length >= 45 && bytes.readUInt32LE(0) === 3, `${role} program data is not an upgradeable-loader program`)
    return { role, programData: addresses[i], build: deployedBuild(role, bytes), deploySlot: Number(bytes.readBigUInt64LE(4)),
      upgradeAuthority: bytes[12] ? new PublicKey(bytes.subarray(13, 45)).toBase58() : null,
      trimmedSha256: bytes.length >= 45 + e.trimmedLength ? sha(bytes.subarray(45, 45 + e.trimmedLength)) : null, expectedTrimmedSha256: e.trimmedSha256 }
  })
  requireNativeBuilds(Object.fromEntries(programs.map(p => [p.role, p.build])))
  return { genesisHash: network.genesisHash, programs }
}

// The preview, then bundle 3 itself (the collector re-checks every pin, the gate, the configs and the trade table).
export async function collectNativeProductionBundle(options) {
  const preview = await previewNativeBundle(options)
  const bundle = await collectProductionOperatorBundle({ ...options, artifacts: nativeProductionArtifacts() })
  return { preview, bundle }
}
