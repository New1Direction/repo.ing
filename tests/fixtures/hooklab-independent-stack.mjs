// hook-lab's independent build (feat/independent-stack): our own stack's real ELFs, compiled at the PLACEHOLDER IDs of
// its ids/independent.json, from the build directory (HOOKLAB_INDEPENDENT_DIR, default
// ~/Documents/ChatGPT/hooks-local-state/independent-<commit>). Every identity and hash is read from the build's files
// (a rebuild changes them all): the ids file, the manifest's kit ID, the ELFs (trimmed pins computed here and checked
// against ELF-HASHES.txt) and the IDLs. Test data only: the placeholder IDs are throwaway keys, never mainnet.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseStack } from '../../src/hooklab-stack.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const state = path.join(homedir(), 'Documents/ChatGPT/hooks-local-state')
function defaultDir() {
  const found = existsSync(state) ? readdirSync(state).filter(name => /^independent-[0-9a-f]{7,40}$/.test(name)).sort() : []
  return found.length ? path.join(state, found.at(-1)) : path.join(state, 'independent')
}
export const INDEPENDENT_DIR = process.env.HOOKLAB_INDEPENDENT_DIR ?? defaultDir()
const ELF_FILES = Object.freeze({ launch: 'bordrless_launch.so', swap: 'bordrless_swap.so', gate: 'hook_max_wallet.so', token: 'bordrless_token.so' })
const IDL_FILES = Object.freeze({ launch: 'bordrless_launch.json', swap: 'bordrless_swap.json', gate: 'hook_max_wallet.json' })
export const INDEPENDENT_SKIP = !['ids/independent.json', 'ids/independent-manifest.json', 'ELF-HASHES.txt', ...Object.values(ELF_FILES).map(f => `elf/${f}`), ...Object.values(IDL_FILES).map(f => `idl/${f}`)]
  .every(file => existsSync(path.join(INDEPENDENT_DIR, file))) && `hook-lab's independent build is not at ${INDEPENDENT_DIR} (HOOKLAB_INDEPENDENT_DIR)`

const trim = bytes => { let end = bytes.length; while (end > 0 && bytes[end - 1] === 0) end--; return bytes.subarray(0, end) }
// upgradeAuthority: the key the test validator names as the programs' upgrade authority (a synthetic role); the ids
// file's own authority otherwise.
export function independentStack({ upgradeAuthority = null } = {}) {
  const read = file => readFileSync(path.join(INDEPENDENT_DIR, file))
  const ids = JSON.parse(read('ids/independent.json')), manifest = JSON.parse(read('ids/independent-manifest.json')), hashes = read('ELF-HASHES.txt').toString()
  if (ids.schema !== 'hook-lab/independent-ids/1' || manifest.schema !== 'hook-lab/independent-ids-manifest/1') throw Error('Unexpected independent ids schema')
  const commit = /@ ([0-9a-f]{40})/.exec(hashes)?.[1]
  if (!commit) throw Error('ELF-HASHES.txt names no source commit')
  const elfs = Object.fromEntries(Object.entries(ELF_FILES).map(([role, file]) => [role, read(`elf/${file}`)]))
  const idls = Object.fromEntries(Object.entries(IDL_FILES).map(([role, file]) => [role, read(`idl/${file}`)]))
  const elf = Object.fromEntries(Object.entries(elfs).map(([role, bytes]) => {
    const t = trim(bytes), line = hashes.split('\n').find(l => l.startsWith(ELF_FILES[role].replace('.so', '')) && l.includes(` id ${ids[role]} `))
    // The build's own record must agree with the bytes on disk (raw and trimmed).
    if (!line || !line.includes(`raw sha256 ${sha(bytes)} len ${bytes.length}`) || !line.includes(`trimmed sha256 ${sha(t)} len ${t.length}`)) throw Error(`${role} ELF differs from ELF-HASHES.txt`)
    return [role, { trimmedSha256: sha(t), trimmedLength: t.length }]
  }))
  const open = JSON.parse(idls.launch).instructions.some(ix => ix.name === 'create_launch_open_v1')
  const stack = parseStack({ schema: 'repoing/hooks-stack/1', id: `independent-${commit.slice(0, 7)}`, status: 'placeholder',
    programs: { launch: ids.launch, swap: ids.swap, gate: ids.gate, token: ids.token }, quoteMint: ids.quoteMarkerMint,
    upgradeAuthority: upgradeAuthority ?? ids.upgradeAuthority, kitProgram: manifest.kitId,
    build: { name: `independent-${commit.slice(0, 7)}`, source: { repo: 'New1Direction/hook-lab', branch: 'feat/independent-stack', commit }, elf,
      idlSha256: Object.fromEntries(Object.entries(idls).map(([role, bytes]) => [role, sha(bytes)])), open } })
  return { stack, elfs, idls }
}
