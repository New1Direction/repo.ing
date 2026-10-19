// Hooks program stacks: the legacy stack is bundle 2 as deployed; our own stack's addresses all come from its descriptor
// and profile, never from constants. No RPC; the relocated ELFs are only read when present.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LEGACY_STACK, coinStack, isStackProfile, kitOf, parseStack, profileRolesDistinct, stackProfile, tokenElfLengthOf } from '../src/hooklab-stack.mjs'
import { derivedAddresses, holdingAddress, authorizationAddress } from '../src/hooklab-owner-driver/pins.mjs'
import { parseInclusiveMaxWalletProfile } from '../src/hooklab-inclusive-max-wallet-profile.mjs'
import { productionArtifacts, productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'
import { stackProductionArtifacts } from '../src/hooklab-production-stack-bundle.mjs'
import { hookCoinAddresses } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import { ownStack, OWN_STACK_SKIP, PLACEHOLDER_IDS, INDEPENDENT_DIR, INDEPENDENT_SKIP } from './fixtures/hooklab-own-stack.mjs'
import { stackFromIndependentBuild } from '../src/hooklab-stack-build.mjs'

const legacyProfile = JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json', import.meta.url)))

test('the legacy stack is exactly bundle 2 as reviewed and deployed', () => {
  assert.deepEqual({ ...LEGACY_STACK.programs }, legacyProfile.programs)
  assert.equal(LEGACY_STACK.quoteMint, legacyProfile.quoteMint)
  assert.equal(kitOf(legacyProfile), LEGACY_STACK.kitProgram); assert.equal(tokenElfLengthOf(legacyProfile), 326504)
  assert.equal(isStackProfile(legacyProfile), false); assert.ok(profileRolesDistinct(legacyProfile))
})

test('addresses are derived only from the programs a caller passes: no stack is assumed', () => {
  assert.throws(() => derivedAddresses(), /programs is required/)
  assert.throws(() => holdingAddress(PLACEHOLDER_IDS.quoteMint, PLACEHOLDER_IDS.launch), /token program is required/)
  assert.throws(() => authorizationAddress(PLACEHOLDER_IDS.launch), /launch program is required/)
  const own = derivedAddresses({ launch: PLACEHOLDER_IDS.launch, swap: PLACEHOLDER_IDS.swap, gate: PLACEHOLDER_IDS.gate, token: PLACEHOLDER_IDS.token }, PLACEHOLDER_IDS.quoteMint)
  assert.equal(Object.keys(own).some(name => name.startsWith('bridge')), false, 'a stack without a bridge has no bridge addresses')
  assert.ok(Object.keys(derivedAddresses(LEGACY_STACK.programs, LEGACY_STACK.quoteMint)).includes('bridgeConfig'))
})

test('a profile is a stack (no bridge, names its stack) or legacy (with its bridge), never both or neither', () => {
  const { bridge, ...four } = legacyProfile.programs
  assert.throws(() => kitOf({ ...legacyProfile, programs: four }), /either a stack/)
  assert.throws(() => kitOf({ ...legacyProfile, stack: { kitProgram: PLACEHOLDER_IDS.gate } }), /either a stack/)
  assert.equal(coinStack({ source: 'open' }), 'own'); assert.equal(coinStack({ source: 'owner-invite' }), 'legacy'); assert.equal(coinStack(null), 'legacy')
})

test('our own stack: its profile carries its programs, marker, pins and kit, and every compiler derives from it', { skip: OWN_STACK_SKIP }, () => {
  const { stack, idls } = ownStack(), artifacts = stackProductionArtifacts(stack, idls), profile = artifacts.base
  assert.deepEqual(profile.programs, stack.programs); assert.equal(profile.quoteMint, stack.quoteMint)
  assert.equal(profile.programs.bridge, undefined); assert.equal(profile.stack.upgradeAuthority, PLACEHOLDER_IDS.upgradeAuthority)
  assert.equal(kitOf(profile), stack.kitProgram); assert.deepEqual(profile.elfSha256.launch, stack.build.elf.launch.trimmedSha256)
  // The served profile (with the owner's menus) parses as a reviewed inclusive profile.
  const parsed = parseInclusiveMaxWalletProfile(JSON.parse(productionProfileJson(profile)))
  assert.equal(parsed.stack.id, stack.id)
  // The coin's accounts come from the stack: nothing in them is a legacy address.
  const a = hookCoinAddresses(profile, PLACEHOLDER_IDS.gate), legacy = hookCoinAddresses(productionArtifacts().base, PLACEHOLDER_IDS.gate)
  // (The kit's own PDA depends only on the kit and the mint; the placeholder stack keeps the legacy kit ID.)
  for (const [name, address] of Object.entries(a)) if (name !== 'kitConfig') assert.notEqual(address, legacy[name], name)
})

test('a stack descriptor is refused when its IDLs are not its build\'s or name other programs', { skip: OWN_STACK_SKIP }, () => {
  const { stack, idls } = ownStack(), base = productionArtifacts().base
  assert.throws(() => stackProfile(base, stack, { ...idls, launch: Buffer.from(readFileSync(new URL('../vendor/hooklab-native-candidate/open-36dd07e/bordrless_launch.json', import.meta.url))) }), /launch IDL differs/)
  const other = ownStack({ seed: 'other' })
  assert.throws(() => stackProfile(base, { ...stack, build: { ...stack.build, idlSha256: other.stack.build.idlSha256 } }, other.idls), /names another program/)
  assert.throws(() => parseStack({ ...stack, quoteMint: stack.programs.token }), /distinct/)
  assert.throws(() => parseStack({ ...stack, id: 'legacy' }))
})

test('our stack from hook-lab\'s independent build: the ids file\'s six fields, pins computed from the files, placeholder until reviewed', { skip: INDEPENDENT_SKIP }, () => {
  const { stack } = stackFromIndependentBuild(INDEPENDENT_DIR), ids = JSON.parse(readFileSync(`${INDEPENDENT_DIR}/ids/independent.json`, 'utf8'))
  assert.deepEqual(stack.programs, { launch: ids.launch, swap: ids.swap, gate: ids.gate, token: ids.token })
  assert.equal(stack.quoteMint, ids.quoteMarkerMint); assert.equal(stack.upgradeAuthority, ids.upgradeAuthority); assert.equal(stack.status, 'placeholder')
  // Every ELF the stack pins is the one hook-lab's own ELF-HASHES.txt records (each of its formats names the raw sha256).
  const hashes = readFileSync(`${INDEPENDENT_DIR}/ELF-HASHES.txt`, 'utf8')
  for (const [role, bytes] of Object.entries(stackFromIndependentBuild(INDEPENDENT_DIR).elfs)) assert.ok(hashes.includes(sha256(bytes)), role)
  assert.equal(stack.build.open, true)
  assert.throws(() => stackFromIndependentBuild(INDEPENDENT_DIR, { reviewed: true }), /placeholder keys/)
})

// hook-lab's ELF-HASHES.txt formats: the annotated one (a "@ <commit>" header, then per program its name, id, raw and
// trimmed sha256 and lengths) and a plain sha256sum listing (independent-e775165), whose source commit is the build's own
// clean-tree record in evidence/final.log. Synthetic ELF bytes beside the build's real ids, manifest and IDLs.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const COMMIT = 'c0ffee'.padEnd(40, '0'), ELF_NAMES = { launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet', token: 'bordrless_token' }
function syntheticBuild(t, { hashes, finalLog = null }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'independent-synthetic-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const sub of ['ids', 'idl']) cpSync(path.join(INDEPENDENT_DIR, sub), path.join(dir, sub), { recursive: true })
  mkdirSync(path.join(dir, 'elf'))
  const elfs = Object.fromEntries(Object.entries(ELF_NAMES).map(([role, name], i) => {
    const bytes = Buffer.concat([Buffer.from(`synthetic ${role} ELF`), Buffer.alloc(i + 3)]); writeFileSync(path.join(dir, 'elf', `${name}.so`), bytes); return [role, bytes] }))
  writeFileSync(path.join(dir, 'ELF-HASHES.txt'), hashes(elfs))
  if (finalLog) { mkdirSync(path.join(dir, 'evidence')); writeFileSync(path.join(dir, 'evidence', 'final.log'), finalLog) }
  return { dir, elfs }
}
const plain = elfs => Object.entries(ELF_NAMES).map(([role, name]) => `${sha256(elfs[role])}  ${name}.so\n`).join('')
const trimmed = bytes => { let end = bytes.length; while (end > 0 && bytes[end - 1] === 0) end--; return bytes.subarray(0, end) }

test('a plain sha256sum ELF-HASHES.txt is accepted with the build\'s clean-tree commit, and checked against every ELF', { skip: INDEPENDENT_SKIP }, t => {
  const { dir, elfs } = syntheticBuild(t, { hashes: plain, finalLog: `== HEAD ${COMMIT} dirty=0\n== ids\n` })
  const { stack } = stackFromIndependentBuild(dir)
  assert.equal(stack.build.source.commit, COMMIT); assert.equal(stack.build.name, 'independent-c0ffee0')
  for (const role of Object.keys(ELF_NAMES)) assert.deepEqual(stack.build.elf[role], { trimmedSha256: sha256(trimmed(elfs[role])), trimmedLength: trimmed(elfs[role]).length }, role)
  // One listed hash is not its file's: refused, naming the program.
  const wrong = syntheticBuild(t, { hashes: e => plain(e).replace(sha256(e.launch), sha256(Buffer.from('another'))), finalLog: `== HEAD ${COMMIT} dirty=0\n` })
  assert.throws(() => stackFromIndependentBuild(wrong.dir), /launch ELF differs from ELF-HASHES.txt/)
  // No clean-tree record of the source commit: refused.
  assert.throws(() => stackFromIndependentBuild(syntheticBuild(t, { hashes: plain }).dir), /names no source commit/)
  assert.throws(() => stackFromIndependentBuild(syntheticBuild(t, { hashes: plain, finalLog: `== HEAD ${COMMIT} dirty=1\n` }).dir), /names no source commit/)
})

test('the annotated ELF-HASHES.txt is still read: its commit header and both hashes and lengths per program', { skip: INDEPENDENT_SKIP }, t => {
  const annotated = elfs => `feat/independent-stack @ ${COMMIT}\n` + Object.entries(ELF_NAMES).map(([role, name]) => { const tr = trimmed(elfs[role])
    return `${name}  raw sha256 ${sha256(elfs[role])} len ${elfs[role].length} | trimmed sha256 ${sha256(tr)} len ${tr.length}\n` }).join('')
  assert.equal(stackFromIndependentBuild(syntheticBuild(t, { hashes: annotated }).dir).stack.build.source.commit, COMMIT)
  const short = syntheticBuild(t, { hashes: e => annotated(e).replace(`len ${e.swap.length} `, `len ${e.swap.length + 1} `) })
  assert.throws(() => stackFromIndependentBuild(short.dir), /swap ELF differs from ELF-HASHES.txt/)
})
