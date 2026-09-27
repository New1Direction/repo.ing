import test from 'node:test'
import assert from 'node:assert/strict'
import { visiblePolling } from '../app/lib/visible-polling.mjs'
import { ownerInvitation } from '../app/lib/owner-invitation.mjs'

test('display polling pauses when hidden, refreshes on return, and never overlaps', async () => {
  const page = new EventTarget(); page.visibilityState = 'visible'
  let tick, calls = 0, finish, cleared = false
  const clock = { setInterval(fn) { tick = fn; return 1 }, clearInterval() { cleared = true } }
  const stop = visiblePolling(() => { calls++; return new Promise(resolve => { finish = resolve }) }, 100, page, clock)
  await tick(); assert.equal(calls, 1)
  finish(); await Promise.resolve()
  page.visibilityState = 'hidden'; await tick(); assert.equal(calls, 1)
  page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')); assert.equal(calls, 2)
  finish(); await Promise.resolve(); stop()
  page.dispatchEvent(new Event('visibilitychange')); await tick(); assert.equal(calls, 2); assert.ok(cleared)
})
test('owner invitation distinguishes actual fees, zero fees, and unavailable fees', () => {
  const args = { repoId: '123', fullName: 'owner/repo' }
  assert.match(ownerInvitation({ ...args, available: '123456789' }), /0.123456789 SOL/)
  assert.match(ownerInvitation({ ...args, available: '0' }), /Future trades/)
  assert.match(ownerInvitation({ ...args, available: null }), /Check whether/)
  assert.match(ownerInvitation(args), /https:\/\/repo.ing\/claim\/123/)
  assert.match(ownerInvitation(args), /read-only/)
})
