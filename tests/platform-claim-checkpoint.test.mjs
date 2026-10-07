import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSettledCheckpoint } from '../src/platform-fees.mjs'

// The check after a settled DAMM platform claim (src/platform-fees.mjs): a position read from an RPC node behind the claim's slot is
// read again instead of being compared (the 2026-10-07 sweep reported a settled claim as failed that way).
const run = ({ landed = [{ slot: 100 }], reads, amount = 50n, max = 10 }) => {
  const sleeps = [], asked = { landed: 0, reads: 0 }
  const connection = { getTransaction: async () => landed[Math.min(asked.landed++, landed.length - 1)] }
  const read = async () => reads[Math.min(asked.reads++, reads.length - 1)]
  return { sleeps, asked, done: checkSettledCheckpoint({ connection, signature: 'sig', read, before: 100n, amount, reads: max, waitMs: 7,
    sleep: async ms => { sleeps.push(ms) } }) }
}
const at = (slot, claimed) => ({ partner: { slot, claimed } })

test('a read behind the claim\'s slot is read again; the first read at or after it is compared', async () => {
  const stale = run({ reads: [at(99, 100n), at(99, 100n), at(100, 150n)] })
  await stale.done
  assert.deepEqual([stale.asked.reads, stale.sleeps], [3, [7, 7]])
  const current = run({ reads: [at(130, 150n)] })
  await current.done
  assert.deepEqual([current.asked.reads, current.sleeps], [1, []])
})

test('a current read that moved by another amount is a mismatch; a read that never catches up says so', async () => {
  await assert.rejects(run({ reads: [at(99, 100n), at(101, 149n)] }).done, /^Error: Partner claim checkpoint differs from the settled amount$/)
  const behind = run({ reads: [at(99, 100n)], max: 4 })
  await assert.rejects(behind.done, /not readable yet: the RPC node is behind the claim/)
  assert.deepEqual([behind.asked.reads, behind.sleeps.length], [4, 3])
})

test('the claim\'s slot is read again until the node has it; no partner position means nothing to compare', async () => {
  const late = run({ landed: [null, { slot: 100 }], reads: [at(120, 150n)] })
  await late.done
  assert.deepEqual([late.asked.landed, late.asked.reads, late.sleeps.length], [2, 2, 1])
  const none = run({ reads: [null] })
  await none.done
  assert.equal(none.asked.reads, 1)
})
