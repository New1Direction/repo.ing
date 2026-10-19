// Bundle 3 readiness, offline: the committed bundle-2 production bundle still verifies, a dossier pinning the native IDLs
// beside the trimmed native ELF hashes binds its configs, and anything else (a tampered native IDL hash, an IDL from the
// other build) is refused. Real-ELF cases skip without the private ELF directories.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { productionAccountBindingMatches, productionDossierSchema } from '../src/hooklab-production-observer.mjs'
import { validateMaxWalletOperatorBindings } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { inclusiveMaxWalletProfileSchema } from '../src/hooklab-inclusive-max-wallet-profile.mjs'
import { MAINNET_GENESIS, collectProductionOperatorBundle, productionArtifacts, productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'
import { NATIVE_ELF, NATIVE_IDL_SHA256 } from '../src/hooklab-native-pins.mjs'
import { isNativeElfPin, nativeProgramDataMatches } from '../src/hooklab-native-launch.mjs'
import { encodeOpenCreationReserved } from '../src/hooklab-launch-config-reserved.mjs'
import { NATIVE_SOURCE_COMMIT, NO_SOURCE_PATCH_SHA256, deployedBuild, nativeProductionArtifacts, requireNativeBuilds } from '../src/hooklab-production-native-bundle.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bundle2 = JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json', import.meta.url)))
const dossier2 = JSON.parse(bundle2.dossierJson)
const NATIVE_ROLES = ['launch', 'swap']
// The live account each pin approved (its reviewed bytes), as an observation would carry it.
const approved = pin => ({ address: pin.address, owner: pin.owner, executable: pin.executable, dataBase64: pin.approvedDataBase64 })
const configPins = dossier => dossier.accounts.filter(a => a.binding === 'config-counters-v1')
// Bundle 2's dossier as bundle 3 pins it: native IDL hashes on both config bindings, trimmed native ELF pins.
function asBundle3(dossier) {
  return { ...dossier,
    programs: dossier.programs.map(p => NATIVE_ROLES.includes(p.role) ? { ...p, elfSha256: NATIVE_ELF[p.role].trimmedSha256, elfLength: NATIVE_ELF[p.role].trimmedLength } : p),
    accounts: dossier.accounts.map(a => a.binding === 'config-counters-v1' ? { ...a, idlSha256: NATIVE_IDL_SHA256[a.role.split('-')[0]] } : a) }
}
const flip = hex => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`

test('the committed bundle-2 production bundle still verifies: config, profile and dossier bindings and every account pin', () => {
  // No RPC is made: the connections only carry the reviewed origins the binding check compares.
  const connections = bundle2.config.providerTrustDomains.map(t => ({ provider: t.provider, connection: { rpcEndpoint: t.origin } }))
  const { dossier, profile } = validateMaxWalletOperatorBindings({ config: bundle2.config, profile: bundle2.profile, dossierJson: bundle2.dossierJson, connections })
  const { base, elfLengths } = productionArtifacts()
  for (const role of ['launch', 'swap', 'gate']) {
    assert.equal(profile.idlSha256[role], base.idlSha256[role], `${role} IDL is the bundle-2 build`)
    assert.equal(profile.elfSha256[role], base.elfSha256[role], `${role} ELF is the bundle-2 build`)
    assert.equal(bundle2.profile.elfLengths[role], elfLengths[role])
  }
  for (const role of NATIVE_ROLES) assert.equal(isNativeElfPin(role, profile.elfSha256[role], bundle2.profile.elfLengths[role]), false)
  const bound = dossier.accounts.filter(a => a.binding)
  assert.deepEqual(bound.map(a => a.role), ['launch-config', 'swap-config', 'quote-mint'])
  for (const pin of bound) assert.ok(productionAccountBindingMatches(pin, approved(pin), dossier), `${pin.role} binds its reviewed bytes`)
})

test('a bundle-3 dossier binds both configs with the native IDLs beside the trimmed native ELF pins', () => {
  const dossier = productionDossierSchema.parse(asBundle3(dossier2))
  for (const role of NATIVE_ROLES) {
    const program = dossier.programs.find(p => p.role === role)
    assert.ok(isNativeElfPin(role, program.elfSha256, program.elfLength))
  }
  for (const pin of configPins(dossier)) {
    assert.equal(pin.idlSha256, NATIVE_IDL_SHA256[pin.role.split('-')[0]])
    assert.ok(productionAccountBindingMatches(pin, approved(pin), dossier), `${pin.role} binds under the native IDL`)
  }
  // The raw build output is the same reviewed build (a ProgramData can hold it with its trailing zeros).
  const raw = { ...dossier, programs: dossier.programs.map(p => NATIVE_ROLES.includes(p.role) ? { ...p, elfSha256: NATIVE_ELF[p.role].sha256, elfLength: NATIVE_ELF[p.role].length } : p) }
  for (const pin of configPins(raw)) assert.ok(productionAccountBindingMatches(pin, approved(pin), raw))
})

test('a tampered native IDL hash, or an IDL from the other build, is refused', () => {
  const native = asBundle3(dossier2)
  for (const pin of configPins(native)) {
    const role = pin.role.split('-')[0], account = approved(pin)
    assert.equal(productionAccountBindingMatches({ ...pin, idlSha256: flip(pin.idlSha256) }, account, native), false, `${role}: tampered native IDL hash`)
    assert.equal(productionAccountBindingMatches({ ...pin, idlSha256: '0'.repeat(64) }, account, native), false, `${role}: unknown IDL hash`)
    // The bundle-2 IDL beside the native ELF, and the native IDL beside the bundle-2 ELF.
    assert.equal(productionAccountBindingMatches({ ...pin, idlSha256: productionArtifacts().base.idlSha256[role] }, account, native), false, `${role}: bundle-2 IDL with native code`)
    const mixed = dossier2.accounts.find(a => a.role === pin.role)
    assert.equal(productionAccountBindingMatches({ ...mixed, idlSha256: NATIVE_IDL_SHA256[role] }, account, dossier2), false, `${role}: native IDL with bundle-2 code`)
    // A tampered native ELF pin is not the native build either.
    const tamperedElf = { ...native, programs: native.programs.map(p => p.role === role ? { ...p, elfSha256: flip(p.elfSha256) } : p) }
    assert.equal(productionAccountBindingMatches(pin, account, tamperedElf), false, `${role}: native IDL beside an unreviewed ELF`)
  }
})

test('bundle-3 artifacts pin the native IDLs, the trimmed ELFs and the native source; every other pin is bundle 2', () => {
  const inclusive = productionArtifacts(), native = nativeProductionArtifacts()
  const profile = inclusiveMaxWalletProfileSchema.parse(JSON.parse(productionProfileJson(native.base)))
  for (const role of NATIVE_ROLES) {
    assert.equal(profile.idlSha256[role], NATIVE_IDL_SHA256[role]); assert.equal(sha(native.idls[role]), NATIVE_IDL_SHA256[role])
    assert.equal(profile.elfSha256[role], NATIVE_ELF[role].trimmedSha256); assert.equal(native.elfLengths[role], NATIVE_ELF[role].trimmedLength)
  }
  assert.equal(profile.idlSha256.gate, inclusive.base.idlSha256.gate); assert.ok(native.idls.gate.equals(inclusive.idls.gate))
  assert.equal(profile.elfSha256.gate, inclusive.base.elfSha256.gate); assert.equal(native.elfLengths.gate, inclusive.elfLengths.gate)
  for (const field of ['programs', 'quoteMint', 'genesisHash', 'buildFeature', 'dependencyObservation', 'capability']) assert.deepEqual(native.base[field], inclusive.base[field], field)
  assert.equal(profile.sourceCommit, NATIVE_SOURCE_COMMIT); assert.equal(NATIVE_SOURCE_COMMIT, 'e357fdf4a5be0d8baa360ec82028441d298b925b')
  assert.equal(profile.sourcePatchSha256, NO_SOURCE_PATCH_SHA256); assert.equal(NO_SOURCE_PATCH_SHA256, sha(''))
  assert.notEqual(native.sdkSha256, inclusive.sdkSha256)
  assert.notEqual(productionProfileJson(native.base), productionProfileJson(inclusive.base))
})

test('a local dry run is only a non-mainnet loopback validator, and a production bundle only mainnet', async () => {
  const at = (...urls) => urls.map((url, i) => ({ provider: `p${i}`, connection: { rpcEndpoint: url, getGenesisHash: async () => { throw Error('no RPC expected') } } }))
  const trustDomains = [{ provider: 'p0', trustDomain: 'a', origin: 'http://127.0.0.1:8899' }, { provider: 'p1', trustDomain: 'b', origin: 'http://localhost:8899' }]
  const local = 'GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC', collect = (connections, network) => collectProductionOperatorBundle({ connections, trustDomains, lookupTable: local, reviewer: local, treasury: local, approvalReference: 'x', network })
  await assert.rejects(collect(at('http://127.0.0.1:8899', 'http://localhost:8899'), { genesisHash: MAINNET_GENESIS, local: true }), /local dry run reads a non-mainnet validator on loopback RPC only/)
  await assert.rejects(collect(at('https://mainnet.helius-rpc.com', 'http://localhost:8899'), { genesisHash: local, local: true }), /local dry run reads a non-mainnet validator on loopback RPC only/)
  await assert.rejects(collect(at('http://127.0.0.1:8899', 'http://localhost:8899'), { genesisHash: local, local: false }), /production bundle is read from mainnet only/)
  await assert.rejects(collect(at('http://127.0.0.1:8899', 'http://localhost:8899'), { genesisHash: local }), /network must name its genesis/)
})

test('the upgrade check names a deployed build only from exact ProgramData bytes', () => {
  const header = (length, fill = 0) => { const b = Buffer.alloc(45 + length, fill); b.writeUInt32LE(3, 0); return b }
  for (const role of NATIVE_ROLES) {
    assert.equal(deployedBuild(role, header(NATIVE_ELF[role].trimmedLength + 64, 7)), 'unknown')
    assert.equal(deployedBuild(role, Buffer.alloc(10)), 'unknown')
    assert.equal(nativeProgramDataMatches(role, header(NATIVE_ELF[role].trimmedLength)), false)
  }
  assert.doesNotThrow(() => requireNativeBuilds({ launch: 'native', swap: 'native' }))
  assert.throws(() => requireNativeBuilds({ launch: 'bundle-2', swap: 'bundle-2' }), /programs not upgraded yet: launch and swap still run the bundle-2 build/)
  assert.throws(() => requireNativeBuilds({ launch: 'native', swap: 'bundle-2' }), /programs not upgraded yet: swap still runs the bundle-2 build/)
  assert.throws(() => requireNativeBuilds({ launch: 'unknown', swap: 'native' }), /launch deployed code is neither the reviewed native build nor the bundle-2 build/)
  assert.throws(() => requireNativeBuilds({ launch: 'native', swap: 'unknown' }), error => error.code === 'PRODUCTION_BUNDLE_REFUSED')
})

const OLD_ELF_DIR = process.env.HOOKLAB_PRODUCTION_ELF_DIR ?? path.join(homedir(), 'Documents/ChatGPT/hooks-local-state/rebuilt-inclusive/elf')
const NATIVE_ELF_DIR = process.env.HOOKLAB_NATIVE_ELF_DIR ?? path.join(homedir(), 'Documents/ChatGPT/hooks-local-state/native-e357fdf')
const elfFiles = NATIVE_ROLES.flatMap(role => [path.join(OLD_ELF_DIR, `bordrless_${role}.so`), path.join(NATIVE_ELF_DIR, `bordrless_${role}.so`)])
test('real ELFs: the native build is recognised trimmed or raw, bundle 2 is named, and a changed byte is neither', { skip: !elfFiles.every(existsSync) && 'needs the bundle-2 and native e357fdf ELFs (HOOKLAB_PRODUCTION_ELF_DIR, HOOKLAB_NATIVE_ELF_DIR)' }, () => {
  const programData = (elf, padding = 0) => { const h = Buffer.alloc(45); h.writeUInt32LE(3, 0); h[12] = 1; return Buffer.concat([h, elf, Buffer.alloc(padding)]) }
  for (const role of NATIVE_ROLES) {
    const native = readFileSync(path.join(NATIVE_ELF_DIR, `bordrless_${role}.so`)), old = readFileSync(path.join(OLD_ELF_DIR, `bordrless_${role}.so`))
    assert.equal(sha(native), NATIVE_ELF[role].sha256)
    const trimmed = native.subarray(0, NATIVE_ELF[role].trimmedLength)
    for (const bytes of [programData(native), programData(trimmed), programData(trimmed, 4096)]) {
      assert.ok(nativeProgramDataMatches(role, bytes)); assert.equal(deployedBuild(role, bytes), 'native')
    }
    assert.equal(deployedBuild(role, programData(old)), 'bundle-2'); assert.equal(nativeProgramDataMatches(role, programData(old)), false)
    const changed = Buffer.from(trimmed); changed[200] ^= 1
    assert.equal(deployedBuild(role, programData(changed)), 'unknown')
    const trailing = programData(trimmed, 8); trailing[trailing.length - 1] = 1
    assert.equal(deployedBuild(role, trailing), 'unknown')
  }
})

test('the launch-config binding lets the governed switches and menus move (reserved bytes 186..203), and nothing else', () => {
  const pin = dossier2.accounts.find(a => a.role === 'launch-config'), approvedBytes = Buffer.from(pin.approvedDataBase64, 'base64')
  const live = mutate => { const b = Buffer.from(approvedBytes); mutate(b); return { ...approved(pin), dataBase64: b.toString('base64') } }
  const open = encodeOpenCreationReserved({ native: true, open: true, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })
  assert.ok(productionAccountBindingMatches(pin, live(b => open.copy(b, 186)), dossier2), 'native and open creation on, with the owner\'s menus')
  assert.ok(productionAccountBindingMatches(pin, live(b => { b[186] = 1 }), dossier2), 'native on alone')
  assert.equal(productionAccountBindingMatches(pin, live(b => { b[187] = 2 }), dossier2), false, 'a switch value the programs never write')
  assert.equal(productionAccountBindingMatches(pin, live(b => { b[249] = 1 }), dossier2), false, 'a reserved byte past the menus')
  assert.equal(productionAccountBindingMatches(pin, live(b => { open.copy(b, 186); b[106] ^= 1 }), dossier2), false, 'the launch fee (bytes 106..114) changed with the switches')
  const swapPin = dossier2.accounts.find(a => a.role === 'swap-config'), swapLive = Buffer.from(swapPin.approvedDataBase64, 'base64'); swapLive[swapLive.length - 1] ^= 1
  assert.equal(productionAccountBindingMatches(swapPin, { ...approved(swapPin), dataBase64: swapLive.toString('base64') }, dossier2), false, 'the swap Config has no such allowance')
})
