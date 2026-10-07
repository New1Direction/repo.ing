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

// A scripted reconciler: each read answers the next result.
function reconciler(...answers) {
  let clock = 0, reads = 0
  return { options: { now: () => clock, read: async () => { reads++; return answers.shift() } }, tick: ms => { clock += ms }, reads: () => reads }
}
const match = claim => ({ status: 'MATCH', onchainCreatorFee: claim, difference: 0n, platform: null })
const lag = { status: 'MISMATCH', onchainCreatorFee: 9n, difference: 2n, platform: null }

test('after a trade the last verified figures stay on screen until the ledger catches up, re-checked every 10 s', async () => {
  const fees = reconciler(match(5n), lag, match(9n))
  assert.equal((await displayFeeStatus('404', fees.options)).onchainCreatorFee, 5n)
  fees.tick(31_000)
  const held = await displayFeeStatus('404', fees.options)
  assert.deepEqual(held, { ...match(5n), lastVerifiedAt: new Date(0).toISOString() }, 'the last MATCH, marked with when it was verified')
  fees.tick(9_000)
  assert.equal(await displayFeeStatus('404', fees.options), held)
  assert.equal(fees.reads(), 2, 'shared for 10 s')
  fees.tick(2_000)
  assert.deepEqual(await displayFeeStatus('404', fees.options), match(9n), 'fresh figures once the ledger matches again')
})

test('an RPC blip keeps the last verified figures too', async () => {
  const fees = reconciler(match(5n), { status: 'UNAVAILABLE', onchainCreatorFee: null })
  await displayFeeStatus('505', fees.options)
  fees.tick(31_000)
  assert.equal((await displayFeeStatus('505', fees.options)).onchainCreatorFee, 5n)
})

test('a pending claim or a ledger ahead of the chain is shown as read, never covered by older figures', async () => {
  const pendingClaim = { status: 'PENDING_REVIEW', onchainCreatorFee: null }, behind = { status: 'MISMATCH', onchainCreatorFee: 1n, difference: -4n, platform: null }
  const fees = reconciler(match(5n), pendingClaim, behind)
  await displayFeeStatus('606', fees.options)
  fees.tick(31_000)
  assert.equal(await displayFeeStatus('606', fees.options), pendingClaim)
  fees.tick(11_000)
  assert.equal(await displayFeeStatus('606', fees.options), behind)
})

test('without a verified read in the last 15 minutes the read is shown as is', async () => {
  const first = reconciler(lag)
  assert.equal(await displayFeeStatus('707', first.options), lag, 'nothing verified yet in this process')
  const fees = reconciler(match(5n), lag)
  await displayFeeStatus('808', fees.options)
  fees.tick(15 * 60_000 + 1)
  assert.equal(await displayFeeStatus('808', fees.options), lag)
})

test('a graduated early access market is never held on screen: it waits for step 7', async () => {
  const fees = reconciler(match(5n), { status: 'UNAVAILABLE', onchainCreatorFee: null, reason: 'EARLY_ACCESS_GRADUATION_PENDING' })
  assert.equal((await displayFeeStatus('909', fees.options)).status, 'MATCH')
  fees.tick(31_000)
  const shown = await displayFeeStatus('909', fees.options)
  assert.deepEqual([shown.status, shown.onchainCreatorFee, shown.lastVerifiedAt], ['UNAVAILABLE', null, undefined])
})
