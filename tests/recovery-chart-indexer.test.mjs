import test from 'node:test'
import assert from 'node:assert/strict'
import { recoveryHistory } from '../scripts/recovery-chart-indexer.mjs'

const pool = '11111111111111111111111111111111'
const item = (signature, slot) => ({ signature, slot, err: null })
const rpc = (endpoint, pages) => ({ rpcEndpoint: endpoint, getSignaturesForAddress: async (_key, { before }, commitment) => {
  assert.equal(commitment, 'finalized')
  return pages[before ?? 'head'] ?? []
} })

test('chart recovery requires complete agreeing history and returns oldest first without the accounting boundary', async () => {
  const pages = { head: [item('new', 33), item('middle', 22)], middle: [item('old', 11), item('boundary', 10)] }
  assert.deepEqual(await recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, 'boundary', { pageSize: 2 }),
    [item('old', 11), item('middle', 22), item('new', 33)])
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('primary', pages), pool, 'boundary'), /INDEPENDENT_RPC_REQUIRED/)
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', { head: [item('different', 33), item('boundary', 10)] }), pool, 'boundary', { pageSize: 2 }), /RPC_DISAGREEMENT/)
  await assert.rejects(recoveryHistory(rpc('primary', { head: [item('new', 33)] }), rpc('verifier', pages), pool, 'boundary'), /CHART_HISTORY_INCOMPLETE/)
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, 'boundary', { pageSize: 2, maxPages: 1 }), /CHART_HISTORY_LIMIT/)
})
