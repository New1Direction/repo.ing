import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ARTIFACT_SKIP_PREFIX, combineSkips, generatedCustomArtifact, generatedMaxWalletArtifact, inclusiveGeneratedArtifact, inclusiveTokenElfPath,
  missingArtifactEnv, missingGeneratedArtifacts, missingInclusiveArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'

test('generated fixture loader defaults to the local fixture and accepts only explicit absolute artifact roots', () => {
  const previous = process.env.HOOKLAB_GENERATED_FIXTURE_DIR
  try {
    delete process.env.HOOKLAB_GENERATED_FIXTURE_DIR
    assert.equal(generatedMaxWalletArtifact('hooklab-max-wallet-rust-vector.json', 'file:///tmp/source/fixture.mjs').href,
      'file:///tmp/source/hooklab-max-wallet-rust-vector.json')
    process.env.HOOKLAB_GENERATED_FIXTURE_DIR = '/tmp/generated-fixtures'
    assert.equal(generatedMaxWalletArtifact('hooklab-max-wallet-buy-rust-vector.json', import.meta.url).href,
      'file:///tmp/generated-fixtures/hooklab-max-wallet-buy-rust-vector.json')
    assert.equal(generatedMaxWalletArtifact('hooklab-max-wallet-buy-app-plan.json',import.meta.url).href,'file:///tmp/generated-fixtures/buy-app-plan.json')
    for (const bad of ['', 'relative/path']) {
      process.env.HOOKLAB_GENERATED_FIXTURE_DIR = bad
      assert.throws(() => generatedMaxWalletArtifact('hooklab-max-wallet-rust-vector.json', import.meta.url), /absolute test-artifact directory/)
    }
  } finally {
    if (previous === undefined) delete process.env.HOOKLAB_GENERATED_FIXTURE_DIR
    else process.env.HOOKLAB_GENERATED_FIXTURE_DIR = previous
  }
})

test('generated fixture loader rejects unrecognized names, traversal and unsupported policy artifacts', () => {
  for (const name of ['../secret', '/tmp/file.json', 'hooklab-custom-stage2-rust-vector.json', 'hooklab-max-wallet-rust-vector.json/extra']) {
    assert.throws(() => generatedMaxWalletArtifact(name, import.meta.url), /Unknown generated max-wallet artifact/)
  }
})

const ARTIFACT_ENV = ['HOOKLAB_GENERATED_FIXTURE_DIR', 'HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR', 'HOOKLAB_INCLUSIVE_TOKEN_ELF', 'HOOKLAB_TEST_ONLY_BINARY']
function withArtifactEnv(changes, work) {
  const previous = Object.fromEntries(ARTIFACT_ENV.map(key => [key, process.env[key]]))
  try {
    for (const key of ARTIFACT_ENV) delete process.env[key]
    Object.assign(process.env, changes)
    return work()
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

test('custom-hook vectors are supplied privately through the same generated-fixture directory', () => {
  withArtifactEnv({}, () => {
    assert.equal(generatedCustomArtifact('hooklab-custom-rust-vector.json', 'file:///tmp/source/fixture.mjs').href, 'file:///tmp/source/hooklab-custom-rust-vector.json')
    process.env.HOOKLAB_GENERATED_FIXTURE_DIR = '/tmp/generated-fixtures'
    assert.equal(generatedCustomArtifact('hooklab-custom-launch-rust-vector.json').href, 'file:///tmp/generated-fixtures/hooklab-custom-launch-rust-vector.json')
    for (const name of ['../secret', 'hooklab-custom-stage2-rust-vector.json', 'hooklab-max-wallet-rust-vector.json']) {
      assert.throws(() => generatedCustomArtifact(name), /Unknown generated custom-hook artifact/)
    }
  })
})

test('absent generated artifacts produce an explicit skip reason naming the file and variable, never a silent pass', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooklab-generated-'))
  try {
    withArtifactEnv({}, () => {
      const reason = missingGeneratedArtifacts(['hooklab-custom-rust-vector.json'], pathToFileURL(join(directory, 'fixture.mjs')))
      assert.equal(reason, `${ARTIFACT_SKIP_PREFIX}: hooklab-custom-rust-vector.json (set HOOKLAB_GENERATED_FIXTURE_DIR)`)
      process.env.HOOKLAB_GENERATED_FIXTURE_DIR = directory
      assert.equal(missingGeneratedArtifacts(['hooklab-max-wallet-buy-app-plan.json']),
        `${ARTIFACT_SKIP_PREFIX}: hooklab-max-wallet-buy-app-plan.json not found in HOOKLAB_GENERATED_FIXTURE_DIR=${directory}`)
      writeFileSync(join(directory, 'buy-app-plan.json'), '{}')
      writeFileSync(join(directory, 'hooklab-custom-rust-vector.json'), '{}')
      assert.equal(missingGeneratedArtifacts(['hooklab-max-wallet-buy-app-plan.json', 'hooklab-custom-rust-vector.json']), false)
      process.env.HOOKLAB_GENERATED_FIXTURE_DIR = 'relative/path'
      assert.throws(() => missingGeneratedArtifacts(['hooklab-custom-rust-vector.json']), /absolute test-artifact directory/)
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('inclusive vectors and token ELF have no sandbox defaults and skip with the variables to set', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hooklab-inclusive-'))
  try {
    withArtifactEnv({}, () => {
      assert.throws(() => inclusiveGeneratedArtifact('inclusive-builder-vector.json'), /HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR must be an absolute/)
      assert.throws(() => inclusiveTokenElfPath(), /HOOKLAB_INCLUSIVE_TOKEN_ELF must be an absolute/)
      assert.throws(() => inclusiveGeneratedArtifact('../inclusive-builder-vector.json'), /Unknown generated inclusive artifact/)
      assert.equal(missingInclusiveArtifacts(['inclusive-builder-vector.json'], { tokenElf: true }), `${ARTIFACT_SKIP_PREFIX}: `
        + 'inclusive-builder-vector.json (set HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR); bordrless_token.so (set HOOKLAB_INCLUSIVE_TOKEN_ELF)')
      writeFileSync(join(directory, 'inclusive-builder-vector.json'), '{}')
      writeFileSync(join(directory, 'bordrless_token.so'), '')
      process.env.HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR = directory
      process.env.HOOKLAB_INCLUSIVE_TOKEN_ELF = join(directory, 'bordrless_token.so')
      assert.equal(inclusiveGeneratedArtifact('inclusive-builder-vector.json'), join(directory, 'inclusive-builder-vector.json'))
      assert.equal(missingInclusiveArtifacts(['inclusive-builder-vector.json'], { tokenElf: true }), false)
      assert.equal(missingInclusiveArtifacts(['inclusive-post-launch-snapshot.json']),
        `${ARTIFACT_SKIP_PREFIX}: inclusive-post-launch-snapshot.json not found in HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR=${directory}`)
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('environment-supplied harness artifacts and combined requirements report every missing piece', () => {
  withArtifactEnv({}, () => {
    assert.equal(missingArtifactEnv(['HOOKLAB_TEST_ONLY_BINARY'], 'test-only harness'), `${ARTIFACT_SKIP_PREFIX}: set HOOKLAB_TEST_ONLY_BINARY (test-only harness)`)
    assert.equal(combineSkips(false, missingArtifactEnv(['HOOKLAB_TEST_ONLY_BINARY'], 'a'), `${ARTIFACT_SKIP_PREFIX}: b`),
      `${ARTIFACT_SKIP_PREFIX}: set HOOKLAB_TEST_ONLY_BINARY (a); b`)
    assert.equal(combineSkips(false, false), false)
    process.env.HOOKLAB_TEST_ONLY_BINARY = '/bin/true'
    assert.equal(missingArtifactEnv(['HOOKLAB_TEST_ONLY_BINARY'], 'test-only harness'), false)
  })
  assert.equal(testRequiring(false), test)
  assert.notEqual(testRequiring(`${ARTIFACT_SKIP_PREFIX}: x`), test)
})
