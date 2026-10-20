// The launch Config's reserved bytes 186..249 as the reviewed programs write them: byte 186 is the native-launches switch,
// byte 187 the open-creation switch (both 0 or 1), then the governed creator-fee and wallet-cap menus (4 u16 bps slots
// each, filled from the front), every later byte zero. One shared check, so preparation, launch and trade compilers keep
// working once the owner turns either switch on (review F1: the preparation compiler refused every preparation while
// byte 186 was 1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCH_CONFIG_RESERVED_AT, OPEN_CREATION_LAYOUT, launchConfigReservedValid, parseLaunchConfigReserved, encodeOpenCreationReserved } from '../src/hooklab-launch-config-reserved.mjs'
import { planInclusiveMaxWalletPreparation } from '../src/hooklab-inclusive-max-wallet-preparation.mjs'
import { inclusiveMaxWalletPreparationFixture } from './fixtures/hooklab-inclusive-max-wallet-preparation.mjs'
import { missingInclusiveArtifacts } from './fixtures/hooklab-generated-artifact.mjs'

const reserved = (first = 0, at = {}) => { const r = Array(64).fill(0); r[0] = first; for (const [i, v] of Object.entries(at)) r[i] = v; return r }
const u16 = (r, at, values) => { values.forEach((v, i) => { r[at + 2 * i] = v & 0xff; r[at + 2 * i + 1] = v >> 8 }); return r }
const menus = (native, open, fee, cap) => u16(u16(reserved(native, { 1: open }), OPEN_CREATION_LAYOUT.feeMenu, fee), OPEN_CREATION_LAYOUT.capMenu, cap)

test('byte 186 (native) and byte 187 (open creation) may be 0 or 1; the menus are well formed; everything after stays zero', () => {
  assert.equal(LAUNCH_CONFIG_RESERVED_AT, 186)
  assert.deepEqual(OPEN_CREATION_LAYOUT, { native: 0, open: 1, feeMenu: 2, capMenu: 10, slots: 4, end: 18 })
  for (const ok of [reserved(0), reserved(1), menus(0, 1, [50], [100]), menus(1, 1, [50, 100, 200], [100, 200, 300, 500]), menus(1, 0, [50], [100]), menus(1, 0, [50, 100, 200], [100, 200, 300, 500]), menus(0, 0, [], [])])
    assert.equal(launchConfigReservedValid(ok), true, JSON.stringify(ok))
  assert.equal(launchConfigReservedValid(Buffer.from(menus(1, 1, [50, 100, 200], [100, 200, 300, 500]))), true, 'raw bytes too')
  for (const bad of [reserved(2), reserved(255), reserved(0, { 1: 2 }), reserved(1, { 63: 9 }), reserved(1, { 18: 1 }),
    menus(1, 1, [0, 100], [100]), menus(1, 1, [50, 50], [100]), menus(1, 1, [10000], [100]), menus(1, 1, [50], [100, 0, 300]), menus(1, 1, [50], [200, 200]),
    menus(1, 1, [200, 100], [100]), menus(1, 1, [50], [500, 100]), reserved(0, { 1: 1 }), menus(1, 1, [50], []), menus(1, 1, [], [100]),
    reserved(0).slice(1), [...reserved(0), 0], null, undefined])
    assert.equal(launchConfigReservedValid(bad), false, JSON.stringify(bad))
})

test('the parsed state names both switches and both menus; encode is its exact inverse', () => {
  assert.deepEqual(parseLaunchConfigReserved(reserved(0)), { native: false, open: false, creatorFeeBps: [], capBps: [] })
  const on = menus(1, 1, [50, 100, 200], [100, 200, 300, 500])
  assert.deepEqual(parseLaunchConfigReserved(on), { native: true, open: true, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })
  assert.deepEqual([...encodeOpenCreationReserved({ native: true, open: true, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })], on)
  assert.equal(parseLaunchConfigReserved(reserved(0, { 1: 2 })), null)
  assert.throws(() => encodeOpenCreationReserved({ native: true, open: true, creatorFeeBps: [1, 2, 3, 4, 5], capBps: [100] }), /at most 4/)
  assert.throws(() => encodeOpenCreationReserved({ native: true, open: true, creatorFeeBps: [], capBps: [100] }), /both non-empty to open creation/)
})

// Review PoC F1a, kept as a regression test, now with open creation on as well.
test('F1a: a preparation still compiles once the native switch and open creation are on', { skip: missingInclusiveArtifacts(['inclusive-builder-vector.json']) }, () => {
  const f = inclusiveMaxWalletPreparationFixture()
  const withBytes = (fixture, bytes) => { const copy = structuredClone(fixture)
    for (const o of copy.observations) { const a = o.accounts[4].account, d = Buffer.from(a.dataBase64, 'base64'); assert.equal(d.length, 250); bytes.forEach((v, i) => { d[186 + i] = v }); a.dataBase64 = d.toString('base64') }
    return copy }
  assert.ok(planInclusiveMaxWalletPreparation(structuredClone(f)), 'switches off: the retained preparation compiles')
  assert.ok(planInclusiveMaxWalletPreparation(withBytes(f, [1])), 'native on: a new launch must still be preparable')
  assert.ok(planInclusiveMaxWalletPreparation(withBytes(f, menus(1, 1, [50, 100, 200], [100, 200, 300, 500]))), 'open creation on with its menus: still preparable')
  for (const [offset, value] of [[186, 2], [187, 2], [249, 1], [204, 1]]) {
    const bad = structuredClone(f)
    for (const o of bad.observations) { const a = o.accounts[4].account, d = Buffer.from(a.dataBase64, 'base64'); d[offset] = value; a.dataBase64 = d.toString('base64') }
    assert.throws(() => planInclusiveMaxWalletPreparation(bad), /Launch configuration layout differs/, `byte ${offset} = ${value}`)
  }
})
