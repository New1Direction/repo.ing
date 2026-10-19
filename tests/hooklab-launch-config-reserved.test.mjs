// The launch Config's reserved bytes 186..249 as the reviewed programs write them: byte 186 is the native-launches switch
// (0 or 1), every later byte zero. One shared check, so preparation keeps working once the owner turns the switch on
// (review F1: the preparation compiler refused every preparation while byte 186 was 1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCH_CONFIG_RESERVED_AT, launchConfigReservedValid } from '../src/hooklab-launch-config-reserved.mjs'
import { planInclusiveMaxWalletPreparation } from '../src/hooklab-inclusive-max-wallet-preparation.mjs'
import { inclusiveMaxWalletPreparationFixture } from './fixtures/hooklab-inclusive-max-wallet-preparation.mjs'
import { missingInclusiveArtifacts } from './fixtures/hooklab-generated-artifact.mjs'

const reserved = (first = 0, at = {}) => { const r = Array(64).fill(0); r[0] = first; for (const [i, v] of Object.entries(at)) r[i] = v; return r }

test('byte 186 may be 0 or 1; bytes 187..249 must stay zero', () => {
  assert.equal(LAUNCH_CONFIG_RESERVED_AT, 186)
  assert.equal(launchConfigReservedValid(reserved(0)), true); assert.equal(launchConfigReservedValid(reserved(1)), true)
  assert.equal(launchConfigReservedValid(Buffer.from(reserved(1))), true, 'raw bytes too')
  for (const bad of [reserved(2), reserved(255), reserved(0, { 1: 1 }), reserved(1, { 63: 9 }), reserved(0).slice(1), [...reserved(0), 0], null, undefined])
    assert.equal(launchConfigReservedValid(bad), false, JSON.stringify(bad))
})

// Review PoC F1a, kept as a regression test.
test('F1a: a preparation still compiles once the native switch is on', { skip: missingInclusiveArtifacts(['inclusive-builder-vector.json']) }, () => {
  const f = inclusiveMaxWalletPreparationFixture()
  assert.ok(planInclusiveMaxWalletPreparation(structuredClone(f)), 'switch off: the retained preparation compiles')
  for (const o of f.observations) { const a = o.accounts[4].account, d = Buffer.from(a.dataBase64, 'base64'); assert.equal(d.length, 250); d[186] = 1; a.dataBase64 = d.toString('base64') }
  assert.ok(planInclusiveMaxWalletPreparation(structuredClone(f)), 'switch on: a new launch must still be preparable')
  for (const [offset, value] of [[186, 2], [187, 1], [249, 1]]) {
    const bad = structuredClone(f)
    for (const o of bad.observations) { const a = o.accounts[4].account, d = Buffer.from(a.dataBase64, 'base64'); d[offset] = value; a.dataBase64 = d.toString('base64') }
    assert.throws(() => planInclusiveMaxWalletPreparation(bad), /Launch configuration layout differs/, `byte ${offset} = ${value}`)
  }
})
