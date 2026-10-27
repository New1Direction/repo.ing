// hook-lab's independent build (feat/independent-stack): our own stack's real ELFs, compiled at the PLACEHOLDER IDs of
// its ids/independent.json, from the build directory (HOOKLAB_INDEPENDENT_DIR, default
// ~/Documents/ChatGPT/hooks-local-state/independent-<commit>). Every identity and hash is read from the build's files
// (a rebuild changes them all): the ids file, the manifest's kit ID, the ELFs (trimmed pins computed here and checked
// against ELF-HASHES.txt) and the IDLs. Test data only: the placeholder IDs are throwaway keys, never mainnet.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { stackFromIndependentBuild } from '../../src/hooklab-stack-build.mjs'

const state = path.join(homedir(), 'Documents/ChatGPT/hooks-local-state')
// A complete build: its ids, manifest, hash record, all four ELFs and the IDLs (a build still being copied is not one).
const ELF_FILES = Object.freeze({ launch: 'bordrless_launch.so', swap: 'bordrless_swap.so', gate: 'hook_max_wallet.so', token: 'bordrless_token.so' })
const IDL_FILES = Object.freeze({ launch: 'bordrless_launch.json', swap: 'bordrless_swap.json', gate: 'hook_max_wallet.json' })
function complete(dir) {
  return ['ids/independent.json', 'ids/independent-manifest.json', 'ELF-HASHES.txt', ...Object.values(ELF_FILES).map(f => `elf/${f}`), ...Object.values(IDL_FILES).map(f => `idl/${f}`)]
    .every(file => existsSync(path.join(dir, file)))
}
function defaultDir() {
  // Pin the complete placeholder release fixture, not the newest build: final owner IDs are
  // deliberately not placeholder test inputs. Override explicitly for another placeholder build.
  return path.join(state, 'independent-2b8b92a')
}
export const INDEPENDENT_DIR = process.env.HOOKLAB_INDEPENDENT_DIR ?? defaultDir()
// Builds at the owner's final IDs (89d060b onward) retired the open-creation fee menu: their launch program refuses a
// non-empty one (OpenMenuInvalid) and takes any whole creator fee up to the ceiling (hook-lab ffeff18).
export const FEE_MENU_RETIRED = (() => { try { return /FINAL/i.test(JSON.parse(readFileSync(path.join(INDEPENDENT_DIR, 'ids/independent.json'), 'utf8')).status ?? '') } catch { return false } })()
export const INDEPENDENT_SKIP = !complete(INDEPENDENT_DIR) && `hook-lab's independent build is not at ${INDEPENDENT_DIR} (HOOKLAB_INDEPENDENT_DIR)`
if (!INDEPENDENT_SKIP && !/PLACEHOLDER/i.test(JSON.parse(readFileSync(path.join(INDEPENDENT_DIR, 'ids/independent.json'), 'utf8')).status ?? '')) {
  throw Error('HOOKLAB_INDEPENDENT_DIR must select a PLACEHOLDER build for this test fixture, not final owner IDs')
}

// upgradeAuthority: the key the test validator names as the programs' upgrade authority (a synthetic role); the ids
// file's own authority otherwise. The build is read as the owner's tools read it (src/hooklab-stack-build.mjs).
export function independentStack({ upgradeAuthority = null } = {}) {
  const { stack, elfs, idls } = stackFromIndependentBuild(INDEPENDENT_DIR, { upgradeAuthority })
  return { stack, elfs, idls }
}
