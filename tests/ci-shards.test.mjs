import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import test from 'node:test'
import { PINNED_GROUPS } from '../scripts/ci/test-matrix.mjs'

test('CI shards cover the serial suite exactly once without splitting or reordering environment groups', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/ci/run-tests.mjs', '--list', ...args], { encoding: 'utf8' })
  const plan = (...args) => {
    const result = run(...args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const serial = plan()
  assert.deepEqual(plan('--shard=serial'), serial)
  const allFiles = readdirSync('tests').filter(file => file.endsWith('.test.mjs')).sort()
  assert.deepEqual(serial.flatMap(group => group.files).sort(), allFiles)
  assert.deepEqual(serial.slice(1).map(group => group.files), PINNED_GROUPS.map(group => group.files.map(file => `${file}.test.mjs`)))

  const shards = ['default', 'primary', 'stock', 'isolated'].map(shard => plan(`--shard=${shard}`))
  assert.deepEqual(shards.flat(1).flatMap(group => group.files).sort(), allFiles)
  assert.deepEqual(shards[0], [serial[0]])
  assert.deepEqual(shards[2].map(group => group.name), serial.filter(group => group.name.startsWith('stock-')).map(group => group.name))
  assert.deepEqual(shards[3].map(group => group.name), ['bundle-launch-chain', 'early-access-launch-chain'])
  for (const groups of shards) {
    // Equality includes environment, unset variables, databases, migration ownership and file order.
    assert.deepEqual(groups, serial.filter(group => groups.some(selected => selected.name === group.name)))
  }

  assert.deepEqual(plan('--shard=primary', 'hf-launch-chain')[0].files, ['hf-launch-chain.test.mjs'])
  assert.deepEqual(plan('--shard=primary', 'hf-launch-db', 'hf-launch-chain', '--exclude=hf-launch-chain')[0].files, ['hf-launch-db.test.mjs'])
  for (const args of [['--shard=typo'], ['--shard=default', '--shard=stock'], ['--typo'], ['missing-test'], ['--exclude=missing-test'], ['--shard=stock', 'hf-launch-chain']]) {
    assert.notEqual(run(...args).status, 0, `must fail closed: ${args}`)
  }
})
