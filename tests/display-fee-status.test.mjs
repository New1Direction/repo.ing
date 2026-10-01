import test from 'node:test'
import assert from 'node:assert/strict'
import { displayFeeStatus } from '../app/lib/server.mjs'

test('token page fee status is shared per repository for 30 s, 10 s while unavailable, and failures are not kept', async () => {
  let clock = 0, reads = 0, answer = { status: 'UNAVAILABLE', onchainCreatorFee: null }
  const read = async () => { reads++; return answer }
  const options = { now: () => clock, read }
  await displayFeeStatus('101', options)
  clock += 9_000
  await displayFeeStatus('101', options)
  assert.equal(reads, 1)
  clock += 2_000
  answer = { status: 'MATCH', onchainCreatorFee: 5n }
  const [a, b] = await Promise.all([displayFeeStatus('101', options), displayFeeStatus('101', options)])
  assert.equal(a, b)
  assert.equal(reads, 2, 'concurrent viewers share one read')
  clock += 29_000
  assert.equal((await displayFeeStatus('101', options)).status, 'MATCH')
  assert.equal(reads, 2)
  clock += 2_000
  await displayFeeStatus('101', options)
  assert.equal(reads, 3)
  await displayFeeStatus('202', options)
  assert.equal(reads, 4, 'per repository')
  await assert.rejects(displayFeeStatus('303', { now: () => clock, read: async () => { throw Error('down') } }), /down/)
  await displayFeeStatus('303', options)
  assert.equal(reads, 5, 'a failed read is retried')
})
