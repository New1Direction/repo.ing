import test from 'node:test'
import assert from 'node:assert/strict'
import { generatedMaxWalletArtifact } from './fixtures/hooklab-generated-artifact.mjs'

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
