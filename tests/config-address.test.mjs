import test from 'node:test'
import assert from 'node:assert/strict'
import { configAddress } from '../app/lib/server.mjs'

// DBC_CONFIG names the config new launches use. With the recovered launch runtime on (production), only that runtime's
// custody-safe config is accepted; the retired 2YbBp or any other value answers unconfigured, so every path fails closed.
const SAFE = '3ZESQPHgao8ZyyEU4tJSwDmrVC3nunhGnTFVGdarRDbZ', PREVIOUS = 'Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7'
const RETIRED = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M'

test('configAddress accepts only the custody-safe config while the recovered launch runtime is on', () => {
  const saved = { config: process.env.DBC_CONFIG, recovery: process.env.ORDINARY_LAUNCH_RECOVERY_ENABLED }
  try {
    process.env.ORDINARY_LAUNCH_RECOVERY_ENABLED = 'true'
    process.env.DBC_CONFIG = SAFE
    assert.equal(configAddress(), SAFE)
    for (const other of [PREVIOUS, RETIRED, '8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3', 'not-a-config']) {
      process.env.DBC_CONFIG = other
      assert.equal(configAddress(), null, `${other.slice(0, 5)} fails closed`)
    }
    delete process.env.DBC_CONFIG
    assert.equal(configAddress(), null)
    process.env.ORDINARY_LAUNCH_RECOVERY_ENABLED = 'false'
    process.env.DBC_CONFIG = RETIRED
    assert.equal(configAddress(), RETIRED, 'local and test runtimes keep their own config')
  } finally {
    for (const [key, value] of [['DBC_CONFIG', saved.config], ['ORDINARY_LAUNCH_RECOVERY_ENABLED', saved.recovery]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})
