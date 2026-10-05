import test from 'node:test'
import assert from 'node:assert/strict'
import { pollStatus } from '../app/lib/status-polling.mjs'
import { allocationStatus } from '../app/lib/allocation.mjs'
import { createBuilderAllocation } from '../src/builder-allocation.mjs'

function fakePage(visible = true) {
  const listeners = new Set()
  return { visibilityState: visible ? 'visible' : 'hidden', listeners,
    addEventListener(type, fn) { assert.equal(type, 'visibilitychange'); listeners.add(fn) },
    removeEventListener(type, fn) { listeners.delete(fn) },
    show() { this.visibilityState = 'visible'; for (const fn of listeners) fn() },
    hide() { this.visibilityState = 'hidden'; for (const fn of listeners) fn() } }
}
function fakeClock() {
  const timers = new Map()
  let next = 1
  return { timers,
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    delays: () => [...timers.values()].map(timer => timer.ms),
    async fire() { const [[id, timer]] = timers; timers.delete(id); await timer.fn() } }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('polls at once, then after the delay each result asks for, and stops when it asks for none', async () => {
  const page = fakePage(), clock = fakeClock(), results = ['locked', 'pending', 'settled']
  let reads = 0
  pollStatus(async () => ({ state: results[reads++] }), result => result.state === 'settled' ? null : result.state === 'pending' ? 5000 : 60000, { page, clock })
  await settle()
  assert.equal(reads, 1)
  assert.deepEqual(clock.delays(), [60000])
  await clock.fire(); await settle()
  assert.deepEqual(clock.delays(), [5000])
  await clock.fire(); await settle()
  assert.equal(reads, 3)
  assert.deepEqual(clock.delays(), [], 'settled: no further reads')
})

test('a hidden page never reads, and reads at once when it becomes visible', async () => {
  const page = fakePage(false), clock = fakeClock()
  let reads = 0
  pollStatus(async () => { reads++; return {} }, () => 60000, { page, clock })
  await settle()
  assert.equal(reads, 0)
  assert.deepEqual(clock.delays(), [])
  page.show(); await settle()
  assert.equal(reads, 1)
  // Hidden again: the scheduled read finds the page hidden and stops until it is shown.
  page.hide()
  await clock.fire(); await settle()
  assert.equal(reads, 1)
  assert.deepEqual(clock.delays(), [])
  page.show(); await settle()
  assert.equal(reads, 2)
})

test('a failed read still schedules the next one; now() reads at once; stop() ends it', async () => {
  const page = fakePage(), clock = fakeClock(), seen = []
  let fail = true, reads = 0
  const poller = pollStatus(async () => { reads++; if (fail) throw Error('down'); return { ok: true } },
    (result, failed) => { seen.push(failed); return 60000 }, { page, clock })
  await settle()
  assert.deepEqual(seen, [true])
  assert.deepEqual(clock.delays(), [60000])
  fail = false
  poller.now(); await settle()
  assert.equal(reads, 2)
  assert.deepEqual(seen, [true, false])
  assert.equal(clock.timers.size, 1, 'the earlier timer was replaced, not doubled')
  poller.stop()
  assert.equal(clock.timers.size, 0)
  assert.equal(page.listeners.size, 0)
  page.show(); await settle()
  assert.equal(reads, 2)
})

test('one read at a time: now() during a read reads once more right after it; a tab shown during a read does not', async () => {
  const page = fakePage(), clock = fakeClock(), delays = []
  let release, reads = 0
  const poller = pollStatus(() => { reads++; return new Promise(resolve => { release = resolve }) },
    (result, failed) => { delays.push(result.n); return 60000 }, { page, clock })
  page.show(); await settle()
  assert.equal(reads, 1, 'shown while reading: no second read')
  release({ n: 1 }); await settle()
  assert.deepEqual(delays, [1])
  void clock.fire(); await settle() // the read it starts stays open until released below
  assert.equal(reads, 2)
  poller.now(); poller.now() // a claim ends while this read runs: its result may be from before the claim
  release({ n: 2 }); await settle()
  assert.equal(reads, 3, 'read again at once, and only once')
  assert.deepEqual(delays, [1], 'the pre-claim result never set the next delay')
  release({ n: 3 }); await settle()
  assert.deepEqual(delays, [1, 3])
  assert.deepEqual(clock.delays(), [60000])
})

test('allocation status: once a market is seen graduated, later reads skip the chain', async () => {
  const asked = []
  const read = state => async options => { asked.push(options.knownGraduated); return { enrolled: true, state } }
  assert.equal((await allocationStatus('501', read('locked'))).state, 'locked')
  assert.equal((await allocationStatus('501', read('available'))).state, 'available')
  assert.equal((await allocationStatus('501', read('available'))).state, 'available')
  assert.deepEqual(asked, [false, false, true])
  // Another market is not affected.
  await allocationStatus('502', read('locked'))
  assert.equal(asked.at(-1), false)
})

test('a known-graduated status reads only the database; paid and confirming allocations still come from it', async () => {
  let latest = null
  const pool = { query: async sql => /from markets/.test(sql)
    ? { rows: [{ githubRepoId: '501', mint: 'So11111111111111111111111111111111111111112', pool: 'So11111111111111111111111111111111111111112',
      creatorWallet: 'So11111111111111111111111111111111111111112', version: 1 }] }
    : { rows: latest ? [latest] : [] } }
  const connection = new Proxy({}, { get: (target, key) => key === 'rpcEndpoint' ? 'http://chain.invalid' : key === 'commitment' ? 'finalized'
    : () => { throw Error(`chain read ${String(key)}`) } })
  const allocation = createBuilderAllocation({ pool, connection, config: 'So11111111111111111111111111111111111111112' })
  // Without it, status reads the chain (here: refused), which is what the memo saves on every later poll.
  await assert.rejects(allocation.status('501'), /chain read|approved DBC config/)
  assert.deepEqual(await allocation.status('501', { knownGraduated: true }), { enrolled: true, amount: '10000000000000', state: 'available' })
  latest = { status: 'pending', signature: 'sig', wallet: 'w', amount: '10000000000000' }
  assert.equal((await allocation.status('501', { knownGraduated: true })).state, 'pending')
  latest = { ...latest, status: 'settled' }
  assert.equal((await allocation.status('501', { knownGraduated: true })).state, 'settled')
})
