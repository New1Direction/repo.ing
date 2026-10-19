// Today's production bundle re-pinned to the reviewed native-SOL builds, as the post-upgrade bundle will be: the profile's
// swap and launch IDLs, ELF hashes and lengths, and the dossier and operator config that bind them. Test-only.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NATIVE_ELF, NATIVE_IDL_SHA256 } from '../../src/hooklab-native-pins.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
export function nativePinned(bundle) {
  const p = JSON.parse(bundle.profile.json), idl = role => readFileSync(new URL(`../../vendor/hooklab-native-candidate/bordrless_${role}.json`, import.meta.url))
  const json = JSON.stringify({ ...p, idlSha256: { ...p.idlSha256, ...NATIVE_IDL_SHA256 }, elfSha256: { ...p.elfSha256, swap: NATIVE_ELF.swap.sha256, launch: NATIVE_ELF.launch.sha256 } })
  const profile = { ...bundle.profile, json, expectedSha256: sha(json), idls: { ...bundle.profile.idls, swap: idl('swap').toString('base64'), launch: idl('launch').toString('base64') },
    elfLengths: { ...bundle.profile.elfLengths, swap: NATIVE_ELF.swap.length, launch: NATIVE_ELF.launch.length } }
  const dossier = JSON.parse(bundle.dossierJson); dossier.artifacts.profileSha256 = profile.expectedSha256
  for (const pin of dossier.programs) if (['swap', 'launch'].includes(pin.role)) Object.assign(pin, { elfSha256: NATIVE_ELF[pin.role].sha256, elfLength: NATIVE_ELF[pin.role].length })
  const dossierJson = JSON.stringify(dossier)
  return { ...bundle, config: { ...bundle.config, profileSha256: profile.expectedSha256, dossierSha256: sha(dossierJson) }, profile, dossierJson }
}
