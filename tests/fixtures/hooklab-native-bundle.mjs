// Today's production bundle re-pinned to the reviewed native-SOL builds, as the post-upgrade bundle will be: the profile's
// swap and launch IDLs, ELF hashes and lengths, and the dossier and operator config that bind them. Test-only.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NATIVE_ELF, NATIVE_IDL_SHA256 } from '../../src/hooklab-native-pins.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
// The two forms a profile may pin a native ELF in: the raw build output, or the trimmed bytes a deployed ProgramData
// holds (trailing zeros removed), as production bundle 3 pins them.
export const NATIVE_ELF_PIN = Object.freeze({
  raw: role => ({ sha256: NATIVE_ELF[role].sha256, length: NATIVE_ELF[role].length }),
  trimmed: role => ({ sha256: NATIVE_ELF[role].trimmedSha256, length: NATIVE_ELF[role].trimmedLength }),
})
// elf: 'raw', 'trimmed', or role => { sha256, length } (null keeps the bundle's own pin for that role); idl: 'native', or
// 'bundle' to keep the bundle's own swap and launch IDLs beside the ELF pins.
export function nativePinned(bundle, { elf = 'raw', idl = 'native' } = {}) {
  const pinOf = typeof elf === 'function' ? elf : NATIVE_ELF_PIN[elf], p = JSON.parse(bundle.profile.json)
  const pins = Object.fromEntries(['swap', 'launch'].map(role => [role, pinOf(role) ?? { sha256: p.elfSha256[role], length: bundle.profile.elfLengths[role] }]))
  const file = role => readFileSync(new URL(`../../vendor/hooklab-native-candidate/bordrless_${role}.json`, import.meta.url))
  const nativeIdls = idl === 'native'
  const json = JSON.stringify({ ...p, idlSha256: nativeIdls ? { ...p.idlSha256, ...NATIVE_IDL_SHA256 } : p.idlSha256,
    elfSha256: { ...p.elfSha256, swap: pins.swap.sha256, launch: pins.launch.sha256 } })
  const profile = { ...bundle.profile, json, expectedSha256: sha(json),
    idls: nativeIdls ? { ...bundle.profile.idls, swap: file('swap').toString('base64'), launch: file('launch').toString('base64') } : bundle.profile.idls,
    elfLengths: { ...bundle.profile.elfLengths, swap: pins.swap.length, launch: pins.launch.length } }
  const dossier = JSON.parse(bundle.dossierJson); dossier.artifacts.profileSha256 = profile.expectedSha256
  for (const pin of dossier.programs) if (pins[pin.role]) Object.assign(pin, { elfSha256: pins[pin.role].sha256, elfLength: pins[pin.role].length })
  const dossierJson = JSON.stringify(dossier)
  return { ...bundle, config: { ...bundle.config, profileSha256: profile.expectedSha256, dossierSha256: sha(dossierJson) }, profile, dossierJson }
}
