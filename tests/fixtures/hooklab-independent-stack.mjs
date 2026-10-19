// hook-lab's independent build (feat/independent-stack): our own stack's real ELFs, compiled at the PLACEHOLDER IDs of
// its ids/independent.json, from the build directory (HOOKLAB_INDEPENDENT_DIR, default
// ~/Documents/ChatGPT/hooks-local-state/independent-<commit>). Every identity and hash is read from the build's files
// (a rebuild changes them all): the ids file, the manifest's kit ID, the ELFs (trimmed pins computed here and checked
// against ELF-HASHES.txt) and the IDLs. Test data only: the placeholder IDs are throwaway keys, never mainnet.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { stackFromIndependentBuild } from '../../src/hooklab-stack-build.mjs'

const state = path.join(homedir(), 'Documents/ChatGPT/hooks-local-state')
function defaultDir() {
  // The newest complete build (a build directory without its ids file is not one to test against yet).
  const found = existsSync(state) ? readdirSync(state).filter(name => /^independent-[0-9a-f]{7,40}$/.test(name)
    && existsSync(path.join(state, name, 'ids', 'independent.json'))).sort((a, b) => statSync(path.join(state, a)).mtimeMs - statSync(path.join(state, b)).mtimeMs) : []
  return found.length ? path.join(state, found.at(-1)) : path.join(state, 'independent')
}
export const INDEPENDENT_DIR = process.env.HOOKLAB_INDEPENDENT_DIR ?? defaultDir()
const ELF_FILES = Object.freeze({ launch: 'bordrless_launch.so', swap: 'bordrless_swap.so', gate: 'hook_max_wallet.so', token: 'bordrless_token.so' })
const IDL_FILES = Object.freeze({ launch: 'bordrless_launch.json', swap: 'bordrless_swap.json', gate: 'hook_max_wallet.json' })
export const INDEPENDENT_SKIP = !['ids/independent.json', 'ids/independent-manifest.json', 'ELF-HASHES.txt', ...Object.values(ELF_FILES).map(f => `elf/${f}`), ...Object.values(IDL_FILES).map(f => `idl/${f}`)]
  .every(file => existsSync(path.join(INDEPENDENT_DIR, file))) && `hook-lab's independent build is not at ${INDEPENDENT_DIR} (HOOKLAB_INDEPENDENT_DIR)`

// upgradeAuthority: the key the test validator names as the programs' upgrade authority (a synthetic role); the ids
// file's own authority otherwise. The build is read as the owner's tools read it (src/hooklab-stack-build.mjs).
export function independentStack({ upgradeAuthority = null } = {}) {
  const { stack, elfs, idls } = stackFromIndependentBuild(INDEPENDENT_DIR, { upgradeAuthority })
  return { stack, elfs, idls }
}
