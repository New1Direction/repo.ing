// Acceptance-only, offline inventory. Never reads keypairs or discovers RPC endpoints.
// Public program identities are reused on a fresh loopback chain, with a disposable
// upgrade authority. This is NOT a release descriptor or production approval.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseStack } from '../../../src/hooklab-stack.mjs'
import { sha256 } from './common.mjs'

const ROOT = '/Users/clubpenguin/Projects/hook-lab-custom-hook-repair'
export const SELECTED_PROGRAM = 'FbAuVaTqVPzs43KdsQE8ByfbMJdRFABanya3fuEVjdRM'
const PINS = Object.freeze({
  launch: ['target/selected-hook-upgrade-candidate/bordrless_launch.so', '3bb8529298e831cf17324ed4b975d4aabc3138c15895237cbee24515fdd10207'],
  swap: ['target/selected-hook-upgrade-candidate/bordrless_swap.so', '3b910ec4ce65051f0cdce1eaf6cda8fff27edea3790f674e8d46482783b82d32'],
  token: ['.amp/in/elf-deployed-token/bordrless_token.so', '5fbbb2ebca32ed3df4c0299da3376141969ac6088700c86390d8b05d0c451dab'],
  gate: ['.amp/in/elf-deployed-token/hook_max_wallet.so', '0f3261b6420f20a3c9feb1d5ead5e8cb432ce972e8716d61dda995fe78c1697b'],
  selected: ['.amp/in/elf-deployed-token/hook_tester.so', '51e101ceefbb9db9518b92c68b134f633087ebb4398729e3336e0674b83b1d3a'],
})
const trim = bytes => { let end = bytes.length; while (end && bytes[end - 1] === 0) end--; return bytes.subarray(0, end) }

export function selectedFixtureStack({ upgradeAuthority, kind = process.env.HOOKS_E2E_SELECTED_FIXTURE ?? 'test', candidate }) {
  if (candidate) kind = 'economic'
  if (!['test', 'production-receipt', 'economic'].includes(kind)) throw Error('Unknown selected-hook fixture')
  if (kind === 'economic' && !candidate) throw Error('Economic fixture requires an explicit verified candidate inventory')
  const receipt = kind === 'production-receipt'
  const pins = candidate ? candidate.pins : receipt ? { ...PINS, selected: ['target/production-transfer-receipt/transfer_receipt_hook.so', '5bf22f1aa461a11e7f755d0cb31129afc9b356e2a37d88cacff1ed7577613e7d'] } : PINS
  const read = file => readFileSync(path.join(ROOT, file))
  const bytes = Object.fromEntries(Object.entries(pins).map(([role, [file, digest]]) => {
    const value = read(file)
    if (sha256(value) !== digest || value.subarray(0, 4).toString('hex') !== '7f454c46') throw Error(`Selected acceptance ${role} ELF differs: ${file}`)
    return [role, value]
  }))
  const ids = JSON.parse(read('ids/independent.json')), manifest = JSON.parse(read('ids/independent-manifest.json'))
  const names = { launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet' }
  const idls = Object.fromEntries(Object.entries(names).map(([role, name]) => {
    if (!candidate) return [role, read(`idl/independent/${name}.json`)]
    const [file, digest] = candidate.idls[role], value = read(file)
    if (sha256(value) !== digest) throw Error(`Economic acceptance ${role} IDL differs: ${file}`)
    return [role, value]
  }))
  for (const [role, value] of Object.entries(idls)) if (JSON.parse(value).address !== ids[role]) throw Error(`Selected acceptance ${role} IDL address differs`)
  const elfs = Object.fromEntries(['launch', 'swap', 'gate', 'token'].map(role => [role, bytes[role]]))
  const stack = parseStack({ schema: 'repoing/hooks-stack/1', id: 'selected-acceptance', status: 'placeholder',
    programs: Object.fromEntries(Object.keys(elfs).map(role => [role, ids[role]])), quoteMint: ids.quoteMarkerMint,
    upgradeAuthority, kitProgram: manifest.kitId,
    build: { name: 'selected-acceptance', source: { repo: 'New1Direction/hook-lab', branch: 'repair/creator-selected-hooks', commit: candidate?.sourceCommit ?? 'd202089dd2271fe329e8604ec42d348cbc1865f9' },
      elf: Object.fromEntries(Object.entries(elfs).map(([role, value]) => [role, { trimmedSha256: sha256(trim(value)), trimmedLength: trim(value).length }])),
      idlSha256: Object.fromEntries(Object.entries(idls).map(([role, value]) => [role, sha256(value)])), open: true } })
  // solana-test-validator's loader preserves full ELF bytes. The selected adapter
  // pins exactly that immutable ProgramData payload, not a trimmed release hash.
  const selectedHookPin = { program: candidate ? candidate.hooks[0].program : receipt ? '4P9UnqR2FgD1XjkcpyWzabQCrhPDTQkZy8631jvTnYqL' : SELECTED_PROGRAM, elfSha256: sha256(bytes.selected), elfLength: bytes.selected.length }
  return Object.freeze({ name: stack.build.name, stack, elfs, idls, ids: stack.programs, quoteMint: stack.quoteMint,
    elfSha256: Object.fromEntries(Object.entries(elfs).map(([role, value]) => [role, sha256(value)])),
    ...(candidate ? { selectedHooks: candidate.hooks.map(h => ({ ...h, bytes: bytes[h.role], pin: { program: h.program, elfSha256: sha256(bytes[h.role]), elfLength: bytes[h.role].length } })) } : {}),
    selected: { bytes: bytes.selected, pin: selectedHookPin, flags: candidate ? candidate.hooks[0].flags : 3, source: candidate ? 'programs/tax_hook/src/lib.rs' : receipt ? 'programs/transfer_receipt_hook/src/lib.rs' : 'programs/hook_tester/src/lib.rs' } })
}
