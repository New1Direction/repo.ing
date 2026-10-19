// Our stack's descriptor from hook-lab's independent-stack build output (feat/independent-stack): its ids file
// (ids/independent.json, schema hook-lab/independent-ids/1: the four programs, the quote marker mint and the upgrade
// authority), its manifest (the kit ID the launch code names), its ELFs (the trimmed hashes a deployed ProgramData holds)
// and its IDLs. Every pin is computed from the files, so a rebuild needs no code change; the owner reviews the result.
// Read-only file access; no RPC, keys or signing.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseStack } from './hooklab-stack.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const trim = bytes => { let end = bytes.length; while (end > 0 && bytes[end - 1] === 0) end--; return bytes.subarray(0, end) }
const FILES = Object.freeze({ launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet', token: 'bordrless_token' })

// upgradeAuthority: only for a disposable test chain whose ProgramData names another key; production keeps the ids file's.
// reviewed: the owner's statement that these are the final IDs (refused while the ids file says PLACEHOLDER).
export function stackFromIndependentBuild(dir, { upgradeAuthority = null, reviewed = false, id = null } = {}) {
  const read = (...parts) => readFileSync(path.join(dir, ...parts))
  const ids = JSON.parse(read('ids', 'independent.json')), manifest = JSON.parse(read('ids', 'independent-manifest.json'))
  if (ids.schema !== 'hook-lab/independent-ids/1' || manifest.schema !== 'hook-lab/independent-ids-manifest/1') throw Error('Not a hook-lab independent-stack build')
  const placeholder = /PLACEHOLDER/i.test(ids.status ?? '')
  if (reviewed && placeholder) throw Error('The ids file still names placeholder keys; the final IDs come from the owner\'s own keypairs')
  const hashes = read('ELF-HASHES.txt').toString('utf8'), commit = /@ ([0-9a-f]{40})/.exec(hashes)?.[1]
  if (!commit) throw Error('ELF-HASHES.txt names no source commit')
  const elfs = Object.fromEntries(Object.entries(FILES).map(([role, name]) => [role, read('elf', `${name}.so`)]))
  // The build's own record must agree with the bytes on disk, raw and trimmed, for each program at its ID.
  for (const [role, name] of Object.entries(FILES)) {
    const t = trim(elfs[role]), line = hashes.split('\n').find(l => l.startsWith(name) && l.includes(` id ${ids[role]} `))
    if (!line || !line.includes(`raw sha256 ${sha(elfs[role])} len ${elfs[role].length}`) || !line.includes(`trimmed sha256 ${sha(t)} len ${t.length}`)) throw Error(`The ${role} ELF differs from ELF-HASHES.txt`)
  }
  const idls = Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, read('idl', `${FILES[role]}.json`)]))
  const pin = role => { const t = trim(elfs[role]); return { trimmedSha256: sha(t), trimmedLength: t.length } }
  const stack = parseStack({ schema: 'repoing/hooks-stack/1', id: id ?? `independent-${commit.slice(0, 7)}`, status: reviewed ? 'reviewed' : 'placeholder',
    programs: { launch: ids.launch, swap: ids.swap, gate: ids.gate, token: ids.token }, quoteMint: ids.quoteMarkerMint,
    upgradeAuthority: upgradeAuthority ?? ids.upgradeAuthority, kitProgram: manifest.kitId,
    build: { name: `independent-${commit.slice(0, 7)}`, source: { repo: 'New1Direction/hook-lab', branch: 'feat/independent-stack', commit },
      elf: Object.fromEntries(Object.keys(FILES).map(role => [role, pin(role)])),
      idlSha256: Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, sha(idls[role])])),
      open: JSON.parse(idls.launch).instructions.some(ix => ix.name === 'create_launch_open_v1') } })
  return Object.freeze({ stack, elfs, idls })
}
