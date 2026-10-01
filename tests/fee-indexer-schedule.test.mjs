import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createActivitySchedule } from '../src/indexer-schedule.mjs'

const MIN = 60_000
const address = () => Keypair.generate().publicKey.toBase58()

// Markets A and B trade on the curve; G graduated (its DAMM cursor is moved by the graduation monitor).
function harness() {
  let clock = Date.parse('2026-09-30T12:00:00Z')
  const markets = ['A', 'B', 'G'].map((name, i) => ({ name, repoId: String(i + 1), mint: address(), pool: address(),
    launchSignature: `${name}-launch`, creatorWallet: address(), indexedAt: new Date(clock - 24 * 60 * MIN),
    curveActivityAt: null, dammPool: name === 'G' ? address() : null, dammActivityAt: null, sessionAt: null }))
  const byPool = new Map(markets.map(market => [market.pool, market]))
  const history = new Map(markets.map(market => [market.pool, [{ signature: market.launchSignature, slot: 1, err: null }]]))
  const cursors = new Map(), checked = [], reads = [], failing = new Set(), failingReads = new Set()
  const query = async (sql, params = []) => {
    if (/advisory/.test(sql)) return { rows: [{ locked: true }] }
    if (/^select github_repo_id::text as "repoId"/.test(sql)) {
      assert.match(sql, /"dammActivityAt"/, 'scheduled runs read activity columns')
      return { rows: markets.map(({ name, ...market }) => ({ ...market })) }
    }
    if (/from fee_events f/.test(sql) || /^select id, detail from graduation_alerts/.test(sql)) return { rows: [] }
    if (/^select last_signature/.test(sql)) return { rows: cursors.has(params[0]) ? [cursors.get(params[0])] : [] }
    if (/^insert into pool_fee_cursors/.test(sql)) { cursors.set(params[0], { last_signature: params[1], last_slot: params[2] }); return { rows: [] } }
    throw new Error(`Unexpected SQL in fake database: ${sql}`)
  }
  const db = { query, connect: async () => ({ query, release() {} }) }
  const connection = { getSignaturesForAddress: async (key, options) => {
    const pool = key.toBase58()
    checked.push(byPool.get(pool).name)
    if (failing.has(pool)) throw Error('RPC unavailable')
    const items = history.get(pool), start = options.before ? items.findIndex(item => item.signature === options.before) + 1 : 0
    return items.slice(start, start + options.limit)
  } }
  let woken = { all: false, pools: new Set() }
  const feed = { poll: async () => { const result = woken; woken = { all: false, pools: new Set() }; return result } }
  const indexer = createExternalFeeIndexer({ pool: db, connection, config: {}, now: () => clock, log: () => {},
    schedule: createActivitySchedule({ now: () => clock, random: () => 1 }), feed,
    accrual: { recordTradeFees: async () => ({ creditedBaseUnits: 1n, eventKeys: [] }) }, recordTrade: async () => 1,
    graduatedFees: { read: async market => {
      const name = byPool.get(market.pool).name
      reads.push(name)
      if (failingReads.has(name)) { failingReads.delete(name); throw Error('DAMM read unavailable') }
      return null
    } } })
  const run = async () => { checked.length = 0; reads.length = 0; const results = await indexer.runOnce(); return { results, checked: [...checked], reads: [...reads] } }
  const get = name => markets.find(market => market.name === name)
  return { run, get, advance: ms => { clock += ms }, now: () => clock, failing, failingReads,
    trade: name => { const pool = get(name).pool; history.get(pool).unshift({ signature: `${name}-${history.get(pool).length}`, slot: 2, err: null }) },
    wake: (...names) => { woken = { all: false, pools: new Set(names.map(name => get(name).pool)) } } }
}

test('scheduled runs skip quiet markets, check woken or active ones, and read graduated fees only when they can change', async () => {
  const h = harness()
  const first = await h.run()
  assert.deepEqual(first.checked, ['A', 'B', 'G'], 'every market is checked once after a restart')
  assert.deepEqual(first.reads, ['A', 'B', 'G'], 'and its graduated fees read once')

  h.advance(5000)
  assert.deepEqual((await h.run()).checked, [], 'a day-old quiet market waits its 5 minute tier')

  h.trade('A'); h.wake('A'); h.advance(5000)
  const woken = await h.run()
  assert.deepEqual(woken.checked, ['A'], 'the config feed wakes only the traded pool')
  assert.equal(woken.results[0].discovered, 1)
  assert.deepEqual(woken.reads, ['A'], 'curve activity may be a migration: graduated fees are read')

  h.advance(5000)
  assert.deepEqual((await h.run()).checked, [], 'an active market is re-checked every 30 s')
  h.advance(30_000)
  const recheck = await h.run()
  assert.deepEqual([recheck.checked, recheck.reads], [['A'], []], 'nothing new: no graduated read for a curve market')
  assert.equal(recheck.results[0].graduatedRead, false)

  h.get('G').dammActivityAt = new Date(h.now()); h.advance(1000)
  const damm = await h.run()
  assert.deepEqual([damm.checked, damm.reads], [['G'], ['G']], 'a moved DAMM cursor makes the graduated snapshot due')

  h.get('B').sessionAt = new Date(h.now()); h.advance(1000)
  assert.deepEqual((await h.run()).checked, ['B'], 'a repo.ing trade session wakes its market')

  h.advance(30_000)
  const trading = await h.run()
  assert.ok(trading.checked.includes('G') && trading.reads.includes('G'), 'a DAMM pool that traded recently is re-read every 30 s')
  assert.ok(!trading.reads.includes('B'), 'a curve market without new transactions is not')

  h.advance(5 * MIN)
  assert.deepEqual((await h.run()).checked, ['A', 'B', 'G'], 'quiet markets are still checked within 5 minutes')
})

test('a failing market backs off instead of being retried every cycle, then recovers', async () => {
  const h = harness()
  await h.run()
  h.failing.add(h.get('B').pool)
  h.wake('B'); h.advance(1000)
  const failed = await h.run()
  assert.deepEqual(failed.checked, ['B'])
  assert.equal(failed.results[0].status, 'ERROR')
  h.advance(1000)
  assert.deepEqual((await h.run()).checked, [], 'backing off for 5 s')
  h.failing.clear(); h.advance(4000)
  const recovered = await h.run()
  assert.deepEqual(recovered.checked, ['B'], 'the pending wake survives the failure')
  assert.equal(recovered.results[0].status, 'OK')
})

test('a graduated read that fails after the cursor moved is retried on the next good check', async () => {
  const h = harness()
  await h.run()
  h.trade('A'); h.wake('A'); h.failingReads.add('A'); h.advance(1000)
  const failed = await h.run()
  assert.deepEqual([failed.checked, failed.reads, failed.results[0].status], [['A'], ['A'], 'ERROR'])
  h.advance(5000)
  const retried = await h.run()
  assert.deepEqual(retried.checked, ['A'], 'the pending wake survives the failure')
  assert.equal(retried.results[0].discovered, 0, 'the cursor had already moved')
  assert.deepEqual(retried.reads, ['A'], 'the graduated snapshot is still read')
})
