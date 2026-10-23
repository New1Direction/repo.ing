import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'

test('accounting indexer refuses an invalid recovery policy in both fee readers', () => {
  const options = { pool: {}, connection: {}, config: '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M',
    custodyRecovery: { version: 999 }, recordTrade: async () => {} }
  assert.throws(() => createExternalFeeIndexer({ ...options, accrual: {} }), /custody binding/)
  assert.throws(() => createExternalFeeIndexer({ ...options, graduatedFees: {} }), /custody binding/)
})

test('worker refuses custody recovery and accounting startup refuses a missing manifest before connection setup', () => {
  for (const [script, message] of [['run-worker.mjs', /Custody recovery requires the accounting-only indexer/],
    ['index-external-fees.mjs', /Cannot load custody recovery manifest/]]) {
    const result = spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, '--once'], {
      env: { PATH: process.env.PATH, CUSTODY_RECOVERY_MANIFEST: '/nonexistent-public-custody-manifest.json' },
      encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.status, 1, result.error?.message)
    assert.match(result.stderr, message)
    assert.doesNotMatch(result.stderr, /DATABASE_URL, SOLANA_RPC_URL/)
  }
})
