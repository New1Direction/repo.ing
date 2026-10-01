import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { ACTIVITY_TIERS, checkInterval, createActivitySchedule, createConfigActivityFeed, graduatedReadDue } from '../src/indexer-schedule.mjs'

const MIN = 60_000

test('quiet markets are checked less often the longer they stay quiet, never less than every 5 minutes', () => {
  assert.equal(checkInterval(0), 30_000)
  assert.equal(checkInterval(10 * MIN - 1), 30_000)
  assert.equal(checkInterval(10 * MIN), 2 * MIN)
  assert.equal(checkInterval(2 * 60 * MIN), 5 * MIN)
  assert.equal(checkInterval(Infinity), 5 * MIN)
  assert.equal(ACTIVITY_TIERS.at(-1)[1], 5 * MIN)
})

test('a market is due first, then by its idle tier, and at once when newer activity is recorded elsewhere', () => {
  let clock = 1_000 * MIN
  const schedule = createActivitySchedule({ now: () => clock })
  assert.equal(schedule.due('pool'), true, 'never checked')
  schedule.checked('pool', { startedAt: clock, active: true })
  clock += 20_000
  assert.equal(schedule.due('pool'), false, 'active market: 30 s tier')
  clock += 10_000
  assert.equal(schedule.due('pool'), true)
  schedule.checked('pool', { startedAt: clock })
  clock += 15 * MIN
  schedule.checked('pool', { startedAt: clock })
  clock += 60_000
  assert.equal(schedule.due('pool'), false, 'quiet for 16 minutes: 2 minute tier')
  assert.equal(schedule.due('pool', { activityAt: clock - 1000 }), true, 'a trade session or cursor move after the last check wakes it')
  assert.equal(schedule.due('pool', { activityAt: clock - 20 * MIN }), false, 'activity before the last check does not')
  clock += 60_000
  assert.equal(schedule.due('pool'), true)
})

test('long-idle markets wait the slowest tier unless woken by the config feed', () => {
  let clock = 0
  const schedule = createActivitySchedule({ now: () => clock })
  schedule.checked('pool', { startedAt: clock })
  clock += 4 * MIN
  assert.equal(schedule.due('pool', { activityAt: -10 * 60 * MIN }), false)
  schedule.wake('pool')
  assert.equal(schedule.due('pool'), true)
  schedule.checked('pool', { startedAt: clock })
  assert.equal(schedule.due('pool'), false, 'the wake is consumed by a successful check')
})

test('failed checks back off exponentially and keep a pending wake until a check succeeds', () => {
  let clock = 0
  const schedule = createActivitySchedule({ now: () => clock, random: () => 1 })
  schedule.checked('pool', { startedAt: clock })
  clock += 1000
  schedule.wake('pool')
  schedule.checked('pool', { startedAt: clock, error: true })
  assert.equal(schedule.due('pool'), false)
  clock += 5000
  assert.equal(schedule.due('pool'), true, 'retry after 5 s, wake still pending')
  schedule.checked('pool', { startedAt: clock, error: true })
  clock += 5000
  assert.equal(schedule.due('pool'), false, 'second failure waits 10 s')
  clock += 5000
  assert.equal(schedule.due('pool'), true)
  for (let i = 0; i < 10; i++) schedule.checked('pool', { startedAt: clock, error: true })
  clock += 119_000
  assert.equal(schedule.due('pool'), false)
  clock += 1000
  assert.equal(schedule.due('pool'), true, 'capped at 2 minutes')
  const never = createActivitySchedule({ now: () => clock, random: () => 1 })
  never.checked('new', { startedAt: clock, error: true })
  assert.equal(never.due('new'), false, 'a market that never succeeded still backs off')
})

test('graduated fee snapshots are read on DAMM activity, every 30 s while the pool trades, first, or on a slow fallback', () => {
  const now = 1_000 * MIN
  const base = { now, lastReadAt: now - MIN, discovered: 0 }
  assert.equal(graduatedReadDue({ ...base, lastReadAt: null }), true)
  assert.equal(graduatedReadDue({ ...base, discovered: 2 }), true, 'curve activity may be the migration')
  assert.equal(graduatedReadDue(base), false, 'quiet curve market')
  assert.equal(graduatedReadDue({ ...base, lastReadAt: now - 60 * MIN }), true, 'hourly fallback for curve markets')
  const graduated = { ...base, dammPool: 'damm' }
  assert.equal(graduatedReadDue(graduated), false)
  assert.equal(graduatedReadDue({ ...graduated, activityAt: new Date(now - 30_000) }), true, 'DAMM activity since the last read')
  assert.equal(graduatedReadDue({ ...graduated, lastReadAt: now - 10_000, activityAt: new Date(now - 2 * MIN) }), false, 'read 10 s ago')
  assert.equal(graduatedReadDue({ ...graduated, lastReadAt: now - 30_000, activityAt: new Date(now - 2 * MIN) }), true, 'trading pool: every 30 s')
  assert.equal(graduatedReadDue({ ...graduated, lastReadAt: now - 5 * MIN, activityAt: new Date(now - 20 * MIN) }), false, 'quiet for 20 minutes')
  assert.equal(graduatedReadDue({ ...graduated, lastReadAt: now - 10 * MIN }), true, '10 minute fallback')
  assert.equal(graduatedReadDue({ ...base, lastReadGraduated: true, lastReadAt: now - 10 * MIN }), true, 'known graduated from the last read')
})

function feedHarness() {
  const config = Keypair.generate().publicKey, [poolA, poolB, other] = [0, 1, 2].map(() => Keypair.generate().publicKey)
  let clock = 0, history = [{ signature: 's1', err: null }], loads = 0
  const accounts = { s2: [poolA, config], s3: [config, poolB], s4: [other, config], s5: [poolB, config] }
  const requests = []
  const connection = { getSignaturesForAddress: async (address, options) => {
    requests.push({ address: address.toBase58(), ...options })
    const end = options.until ? history.findIndex(item => item.signature === options.until) : history.length
    return history.slice(0, end === -1 ? history.length : end).slice(0, options.limit)
  } }
  const loadTransaction = async (_connection, signature) => {
    loads++
    if (signature === 'broken') throw Error('RPC down')
    return { transaction: { message: { accountKeys: accounts[signature] } } }
  }
  const feed = createConfigActivityFeed({ connection, configs: [config], loadTransaction, now: () => clock, limit: 4 })
  const pools = [poolA, poolB].map(key => key.toBase58())
  return { feed, pools, poolA, poolB, requests, push: (...items) => { history = [...items, ...history] },
    advance: ms => { clock += ms }, loads: () => loads }
}

test('config activity feed wakes exactly the market pools named by new successful transactions', async () => {
  const h = feedHarness()
  const first = await h.feed.poll(h.pools)
  assert.equal(first.all, true, 'first poll only learns the cursor')
  assert.equal(h.requests[0].limit, 1)
  assert.equal((await h.feed.poll(h.pools)).pools.size, 0, 'polls are paced')
  h.advance(10_000)
  h.push({ signature: 's4', err: null }, { signature: 's3', err: { InstructionError: [] } }, { signature: 's2', err: null })
  const second = await h.feed.poll(h.pools)
  assert.equal(second.all, false)
  assert.deepEqual([...second.pools], [h.poolA.toBase58()], 'failed s3 is skipped; s4 names no market pool')
  assert.equal(h.requests.at(-1).until, 's1')
  h.advance(10_000)
  assert.deepEqual([...(await h.feed.poll(h.pools)).pools], [], 'cursor advanced to s4')
  assert.equal(h.requests.at(-1).until, 's4')
})

test('config activity feed overflow wakes everything; a failed read is retried from the same cursor', async () => {
  const h = feedHarness()
  await h.feed.poll(h.pools)
  h.advance(10_000)
  h.push({ signature: 'broken', err: null })
  await assert.rejects(h.feed.poll(h.pools), /RPC down/)
  h.advance(10_000)
  await assert.rejects(h.feed.poll(h.pools), /RPC down/)
  assert.equal(h.requests.at(-1).until, 's1', 'cursor did not move past the unread transaction')
  h.push({ signature: 'y', err: null }, { signature: 'x', err: null }, { signature: 's5', err: null })
  h.advance(10_000)
  const overflow = await h.feed.poll(h.pools)
  assert.equal(overflow.all, true, 'more new signatures than one page: wake every market')
  h.advance(10_000)
  assert.equal((await h.feed.poll(h.pools)).all, false)
  assert.equal(h.requests.at(-1).until, 'y')
})
