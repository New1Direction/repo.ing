import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { dammSwapEvents, dammTradesLockKey, indexDammTradesLocked } from '../src/damm-trades.mjs'
import { createGraduatedTradeIndexer, createLiveTrades, insertLiveTrades, liveTradeRows, pruneLiveTrades } from '../src/live-trades.mjs'

// Real mainnet transactions; no RPC is touched. $REPOING's graduated DAMM pool, and a curve market's swap2 sell.
const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const dbcRaw = JSON.parse(readFileSync(new URL('./fixtures/dbc-swap2-mainnet.json', import.meta.url), 'utf8'))
const DBC_SIGNATURE = '5bMSThjxQL4LDoKnSZkZkjRLYy6ggGcaW6tr1yTZEgmjZfY3wFaqZW7rEDA7bBhjppnzVxqaVX4Y1EQjK6oMMgvc'
const CONFIG = 'BePhDoh7TVPpQGNG7L5yPerN11DCXMJ3DVRQxHtgeMBV'
const curve = { repoId: '77', pool: '7r5iNAJcjLho4rCYu71D5sSbk4Hwg7uZBZoKVAXyHdc1', mint: '4axvA9WtT1xhEaofaSxaVm2KzZCco4eax2HnzJLqQdYn' }
const repoing = { repoId: '1388219884', mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', pool: 'Gda7Sig9EtVpB7EMVWG1eAAoX8kvq4j68nELsnq3Qfi7' }
const migration = { pool: swaps.pool, signature: 'migration-signature', slot: '451432143' }
const offline = new Connection('http://127.0.0.1:1')
const coder = new CpAmm(offline)._program.coder
const dbc = new DynamicBondingCurveClient(offline, 'confirmed')
const parsers = { resolveConfig: () => new PublicKey(CONFIG), dbc, coder }
const load = raw => normalizeFinalizedTransaction(structuredClone(raw), raw.transaction.signatures[0])
const watched = { curves: new Map([[curve.pool, curve]]), damms: new Map([[swaps.pool, { market: repoing, migration }]]) }

test('a confirmed DAMM swap becomes the same row the finalized indexer would store, marked with its venue', () => {
  for (const side of ['buy', 'sell']) {
    const tx = load(swaps[side]), signature = tx.transaction.signatures[0]
    const [expected] = dammSwapEvents(tx, repoing, swaps.pool, coder)
    const rows = liveTradeRows(tx, signature, watched, parsers)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], { signature, eventIndex: expected.eventIndex, repoId: repoing.repoId, venue: 'DAMM', pool: swaps.pool,
      slot: tx.slot, tradedAt: expected.tradedAt, direction: side, quoteAmount: expected.quoteAmount, baseAmount: expected.baseAmount,
      nextSqrtPrice: expected.nextSqrtPrice })
  }
})

test('a confirmed curve swap maps SOL and token amounts the way the chart reads trade_events', () => {
  const tx = normalizeFinalizedTransaction(structuredClone(dbcRaw), DBC_SIGNATURE)
  const [row] = liveTradeRows(tx, DBC_SIGNATURE, watched, parsers)
  // A sell: tokens in, lamports out.
  assert.deepEqual(row, { signature: DBC_SIGNATURE, eventIndex: 0, repoId: '77', venue: 'DBC', pool: curve.pool, slot: 451510431,
    tradedAt: new Date(1790649812 * 1000), direction: 'sell', quoteAmount: '116724093', baseAmount: '203363672029',
    nextSqrtPrice: '442326561584136422' })
})

test('failed, unwatched or unparseable transactions add no rows and never hide another market in the same transaction', () => {
  const tx = load(swaps.buy), signature = tx.transaction.signatures[0]
  assert.deepEqual(liveTradeRows({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, 'Custom'] } } }, signature, watched, parsers), [])
  assert.deepEqual(liveTradeRows(tx, signature, { curves: new Map(), damms: new Map() }, parsers), [])
  // The curve market's config cannot be resolved: reported, while the DAMM pool's swap in the same transaction still counts.
  const both = { curves: new Map([[swaps.pool, curve]]), damms: watched.damms }, failures = []
  const rows = liveTradeRows(tx, signature, both, { ...parsers, resolveConfig: () => { throw Error('CONFIG_UNRESOLVED') } }, failures)
  assert.deepEqual(rows.map(row => row.venue), ['DAMM'])
  assert.deepEqual(failures, ['CONFIG_UNRESOLVED'])
})

test('rows go in as one statement that ignores swaps already written, and expiry deletes rows two minutes old', async () => {
  const calls = []
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: params.length === 1 ? 3 : 2 } } }
  const tx = load(swaps.buy), rows = liveTradeRows(tx, tx.transaction.signatures[0], watched, parsers)
  assert.equal(await insertLiveTrades(pool, [...rows, { ...rows[0], eventIndex: rows[0].eventIndex + 1 }]), 2)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /on conflict \(signature, event_index\) do nothing/)
  assert.equal(calls[0].params.length, 22)
  assert.deepEqual(calls[0].params.slice(2, 6), [repoing.repoId, 'DAMM', swaps.pool, String(tx.slot)])
  assert.equal(await insertLiveTrades(pool, []), 0)
  assert.equal(calls.length, 1)
  assert.equal(await pruneLiveTrades(pool), 3)
  assert.deepEqual(calls[1].params, [120])
})

// Like web3.js 1.x: identical subscriptions share one Set of callbacks, and removing a client subscription deletes its callback
// from that Set (the server subscription ends when the Set is empty).
function fakeConnection({ hangUnsubscribe = false } = {}) {
  const sets = new Map(), ids = new Map(), removed = []
  const socket = { autoReconnect: true, setAutoReconnect(value) { this.autoReconnect = value } }
  let next = 1
  return { sets, removed, socket, _rpcWebSocket: socket,
    onLogs(key, callback, commitment) {
      assert.equal(commitment, 'confirmed')
      const address = key.toBase58(), id = next++
      if (!sets.has(address)) sets.set(address, new Set())
      sets.get(address).add(callback); ids.set(id, { address, callback })
      return id
    },
    async removeOnLogsListener(id) {
      const { address, callback } = ids.get(id); ids.delete(id); removed.push(address)
      if (hangUnsubscribe) { sets.get(address).delete(callback); if (!sets.get(address).size) sets.delete(address); return new Promise(() => {}) }
      sets.get(address).delete(callback)
      if (!sets.get(address).size) sets.delete(address)
    },
    deliver(address, logs, context = {}) { for (const callback of sets.get(address) ?? []) callback(logs, context) } }
}
const addresses = connection => [...connection.sets.keys()].sort()
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('the watcher subscribes to approved configs with curve markets and graduated pools, and follows market changes', async () => {
  // The fixture's curve pool is canonical for its approved config, which is what the real resolver checks.
  assert.ok(deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(curve.mint), new PublicKey(CONFIG)).equals(new PublicKey(curve.pool)))
  let clock = 0, current = watched
  const connection = fakeConnection()
  const live = createLiveTrades({ pool: {}, connect: () => connection, config: CONFIG, legacyConfigs: '', now: () => clock,
    markets: async () => current, newestFinalized: async () => null })
  assert.deepEqual(await live.refresh(), { subscriptions: 2, curves: 1, graduated: 1, invalid: 0, renewed: false })
  assert.deepEqual(addresses(connection), [CONFIG, swaps.pool].sort())
  clock += 1000
  assert.equal(await live.refresh(), null, 'not due yet')
  // The curve market graduated away: its config is dropped, the DAMM pool kept.
  current = { curves: new Map(), damms: watched.damms }
  await live.refresh({ force: true })
  await settle()
  assert.deepEqual(addresses(connection), [swaps.pool])
  assert.deepEqual(connection.removed, [CONFIG])
  // Dropped and watched again: each time a fresh subscription, and only one callback once the old ones are torn down.
  current = watched
  await live.refresh({ force: true })
  current = { curves: new Map(), damms: watched.damms }
  await live.refresh({ force: true })
  current = watched
  await live.refresh({ force: true })
  await settle()
  assert.deepEqual(addresses(connection), [CONFIG, swaps.pool].sort())
  assert.equal(connection.sets.get(CONFIG).size, 1)
  await live.stop()
  await settle()
  assert.equal(connection.sets.size, 0)
})

test('a notification is read once at confirmed, written, and wakes finalized reads for a graduated market', async () => {
  const connection = fakeConnection(), loads = [], inserts = [], woken = []
  const tx = load(swaps.sell), signature = tx.transaction.signatures[0]
  let attempts = 0
  const live = createLiveTrades({ pool: { query: async (sql, params) => { inserts.push(params); return { rowCount: 1 } } }, connect: () => connection,
    config: CONFIG, legacyConfigs: '', delays: [0, 0, 0], markets: async () => watched, onDammSwap: repoId => woken.push(repoId),
    // The node has not seen it for two reads, then answers.
    loadTransaction: async (rpc, value) => { loads.push(value); return ++attempts < 3 ? null : tx } })
  await live.refresh()
  connection.deliver(swaps.pool, { signature, err: null }, { slot: tx.slot })
  connection.deliver(swaps.pool, { signature, err: null }, { slot: tx.slot }) // the same swap again (another subscription, a resubscribe)
  connection.deliver(swaps.pool, { signature: 'failed-signature', err: { InstructionError: [0, 'Custom'] } }, { slot: tx.slot })
  await settle()
  assert.deepEqual(loads, [signature, signature, signature])
  assert.equal(inserts.length, 1)
  assert.deepEqual(woken, [repoing.repoId])
  const stats = live.stats()
  assert.equal(stats.notifications, 3)
  assert.equal(stats.inserted, 1)
  assert.equal(stats.transactions, 1)
  assert.equal(live.stats().notifications, 0, 'counters reset after each read')
})

test('a transaction the node never returns is counted, and a read failure never stops later notifications', async () => {
  const connection = fakeConnection(), tx = load(swaps.buy), inserts = []
  const live = createLiveTrades({ pool: { query: async (sql, params) => { inserts.push(params); return { rowCount: 1 } } }, connect: () => connection,
    config: CONFIG, legacyConfigs: '', delays: [0], markets: async () => watched,
    loadTransaction: async (rpc, signature) => signature === 'missing' ? null : signature === 'broken' ? Promise.reject(Object.assign(Error('x'), { status: 503 })) : tx })
  await live.refresh()
  for (const signature of ['missing', 'broken', tx.transaction.signatures[0]]) connection.deliver(swaps.pool, { signature, err: null })
  await settle()
  const stats = live.stats()
  assert.equal(stats.missing, 1)
  assert.deepEqual(stats.errors, { HTTP_503: 1 })
  assert.equal(inserts.length, 1)
})

test('a websocket that missed a finalized trade moves to a fresh connection; a quiet market alone is not deaf', async () => {
  let clock = 0, newest = null
  const connections = []
  const live = createLiveTrades({ pool: {}, config: CONFIG, legacyConfigs: '', now: () => clock, markets: async () => watched,
    connect: () => { connections.push(fakeConnection()); return connections.at(-1) }, newestFinalized: async () => newest })
  await live.refresh()
  clock = 120_000
  connections[0].deliver(swaps.pool, { signature: 'heard', err: { InstructionError: [0, 'Custom'] } })
  // Finalized 50 s after the last notification: within the margin (a notification arrives ~1.5 s after its block).
  clock = 200_000; newest = new Date(170_000)
  assert.equal((await live.refresh()).renewed, false)
  // Hours of silence with no newer finalized trade: quiet, not deaf.
  clock = 4 * 3600_000
  assert.equal((await live.refresh()).renewed, false)
  // A finalized trade more than 60 s after anything was heard: renewed on a new connection.
  newest = new Date(4 * 3600_000 - 1000)
  const renewed = await live.refresh({ force: true })
  await settle()
  assert.equal(renewed.renewed, true)
  assert.equal(connections.length, 2)
  assert.deepEqual(addresses(connections[0]), [])
  assert.deepEqual(addresses(connections[1]), [CONFIG, swaps.pool].sort())
  assert.equal(live.stats().renewals, 1)
  // The old socket stops reconnecting by itself, so one that never answers cannot keep a loop going.
  assert.equal(connections[0].socket.autoReconnect, false)
  assert.equal(connections[1].socket.autoReconnect, true)
  // The renewal counts as hearing: the same evidence does not renew again.
  clock += 60_000
  assert.equal((await live.refresh()).renewed, false)
  assert.equal(connections.length, 2)
})

test('renewals back off from ten minutes, stop after three in a row with nothing heard, and start over once heard', async () => {
  let clock = 0
  const connections = []
  const live = createLiveTrades({ pool: {}, config: CONFIG, legacyConfigs: '', now: () => clock, markets: async () => watched,
    connect: () => { connections.push(fakeConnection({ hangUnsubscribe: true })); return connections.at(-1) },
    newestFinalized: async () => new Date(clock - 1000) })
  await live.refresh()
  const renewedAt = []
  for (clock = 120_000; clock <= 3 * 3600_000; clock += 60_000) if ((await live.refresh()).renewed) renewedAt.push(clock / 60_000)
  // At 2 min, then 10 and 20 minutes later; then it stops, an unanswered unsubscribe never holding anything up.
  assert.deepEqual(renewedAt, [2, 12, 32])
  assert.equal(connections.length, 4)
  assert.equal(live.stats().errors.LIVE_WEBSOCKET_DEAF, 1)
  // Heard again, then a finalized trade over a minute later goes unannounced: renewals are allowed again.
  connections.at(-1).deliver(swaps.pool, { signature: 'heard-again', err: { InstructionError: [0, 'Custom'] } })
  clock += 60_000
  assert.equal((await live.refresh()).renewed, false, 'heard a minute ago')
  clock += 60_000
  assert.equal((await live.refresh()).renewed, true)
})

test('a deafness check that cannot be read still lets the subscriptions follow the markets', async () => {
  let current = watched
  const connection = fakeConnection()
  const live = createLiveTrades({ pool: {}, connect: () => connection, config: CONFIG, legacyConfigs: '', markets: async () => current,
    newestFinalized: async () => { throw Object.assign(Error('timeout'), { code: '57014' }) } })
  await live.refresh()
  current = { curves: new Map(), damms: watched.damms }
  const result = await live.refresh({ force: true })
  await settle()
  assert.equal(result.renewed, false)
  assert.deepEqual(addresses(connection), [swaps.pool])
  assert.deepEqual(live.stats().errors, { DB_57014: 1 })
})

test('reads are capped (a flood is dropped, not queued) and skipped while the primary provider backs off', async () => {
  let clock = 0, paused = false
  const connection = fakeConnection(), loads = []
  const live = createLiveTrades({ pool: { query: async () => ({ rowCount: 0 }) }, connect: () => connection, config: CONFIG, legacyConfigs: '',
    now: () => clock, markets: async () => watched, readsPerSecond: 1, burst: 2, delays: [0], paused: () => paused,
    loadTransaction: async (rpc, signature) => { loads.push(signature); return signature === 'retry' && loads.length < 2 ? null : load(swaps.buy) } })
  await live.refresh()
  for (const signature of ['a', 'b', 'c', 'd']) connection.deliver(swaps.pool, { signature, err: null })
  await settle()
  assert.deepEqual(loads, ['a', 'b'])
  let stats = live.stats()
  assert.equal(stats.limited, 2)
  // A second later one token is back; a retry needs one of its own.
  clock += 1000
  loads.length = 0
  connection.deliver(swaps.pool, { signature: 'retry', err: null })
  await settle()
  assert.deepEqual(loads, ['retry'])
  assert.equal(live.stats().limited, 1)
  clock += 5000
  paused = true
  connection.deliver(swaps.pool, { signature: 'during-backoff', err: null })
  await settle()
  stats = live.stats()
  assert.equal(stats.paused, 1)
  assert.equal(loads.includes('during-backoff'), false)
})

function graduatedFixture({ newest = 'new-signature', cursor = 'old-signature', busy = false, index } = {}) {
  const queries = [], indexed = []
  const db = { query: async sql => { queries.push(sql); return { rows: [] } }, release() { queries.push('release') } }
  const pool = { query: async (sql, params) => ({ rows: cursor === null ? [] : [{ last_signature: cursor }] }), connect: async () => db }
  const connection = { reads: 0, async getSignaturesForAddress(key, options, commitment) {
    this.reads++
    assert.equal(key.toBase58(), swaps.pool); assert.equal(options.limit, 1); assert.equal(commitment, 'finalized')
    return newest ? [{ signature: newest }] : []
  } }
  const markets = async () => ({ damms: watched.damms })
  return { queries, indexed, pool, connection, markets,
    index: index ?? (async args => { indexed.push(args); return busy ? { complete: false, busy: true, transactions: 0 } : { complete: true, transactions: 2 } }) }
}

test('graduated markets: one primary read skips the two-provider walk when nothing new is finalized', async () => {
  let clock = 0
  const f = graduatedFixture({ newest: 'old-signature' })
  const indexer = createGraduatedTradeIndexer({ pool: f.pool, connection: f.connection, verification: {}, now: () => clock, index: f.index, markets: f.markets })
  assert.deepEqual(await indexer.runOnce(), [{ repoId: repoing.repoId, status: 'CURRENT' }])
  assert.equal(f.indexed.length, 0)
  clock += 5_000
  assert.deepEqual(await indexer.runOnce(), [], 'not due again before 10 s')
  clock += 5_000
  await indexer.runOnce()
  assert.equal(f.connection.reads, 2)
})

test('graduated markets: a new finalized swap is walked with the verified migration on its own client', async () => {
  const f = graduatedFixture()
  const indexer = createGraduatedTradeIndexer({ pool: f.pool, connection: f.connection, verification: { verification: true }, index: f.index, markets: f.markets })
  assert.deepEqual(await indexer.runOnce(), [{ repoId: repoing.repoId, status: 'INDEXED', transactions: 2 }])
  const [args] = f.indexed
  assert.deepEqual(args.graduation, { pool: swaps.pool, signature: 'migration-signature', slot: 451432143 })
  assert.equal(args.market.githubRepoId, repoing.repoId)
  assert.deepEqual(args.verification, { verification: true })
  assert.equal(args.db.release !== undefined, true)
  assert.deepEqual(f.queries, ['release'], 'the client is released; the walk takes its own lock (indexDammTradesLocked)')
  // With no cursor yet, the migration itself is the boundary.
  const fresh = graduatedFixture({ newest: 'migration-signature', cursor: null })
  const idle = createGraduatedTradeIndexer({ pool: fresh.pool, connection: fresh.connection, verification: {}, index: fresh.index, markets: fresh.markets })
  assert.equal((await idle.runOnce())[0].status, 'CURRENT')
})

test('graduated markets: a walk already running retries in 2 s, a failure backs off, and a wake rechecks until the swap is final', async () => {
  let clock = 0
  const busy = graduatedFixture({ busy: true })
  const waiting = createGraduatedTradeIndexer({ pool: busy.pool, connection: busy.connection, verification: {}, now: () => clock, index: busy.index, markets: busy.markets })
  assert.equal((await waiting.runOnce())[0].status, 'BUSY')
  assert.equal(busy.queries.at(-1), 'release')
  clock += 2_000
  assert.equal((await waiting.runOnce())[0].status, 'BUSY')

  const failing = graduatedFixture({ index: async () => { throw Error('DAMM_HISTORY_INCOMPLETE') } })
  const backoff = createGraduatedTradeIndexer({ pool: failing.pool, connection: failing.connection, verification: {}, now: () => clock, index: failing.index, markets: failing.markets })
  assert.deepEqual(await backoff.runOnce(), [{ repoId: repoing.repoId, status: 'ERROR', code: 'DAMM_HISTORY_INCOMPLETE' }])
  clock += 29_000
  assert.deepEqual(await backoff.runOnce(), [])

  const quiet = graduatedFixture({ newest: 'old-signature' })
  const woken = createGraduatedTradeIndexer({ pool: quiet.pool, connection: quiet.connection, verification: {}, now: () => clock, index: quiet.index, markets: quiet.markets })
  await woken.runOnce()
  woken.wake(repoing.repoId) // confirmed just now: due once it should be final, 13 s on, then every 3 s while it is not
  clock += 9_000
  assert.deepEqual(await woken.runOnce(), [])
  clock += 4_000
  assert.equal((await woken.runOnce())[0].status, 'CURRENT')
  clock += 3_000
  assert.equal((await woken.runOnce())[0].status, 'CURRENT')
  assert.equal(quiet.connection.reads, 3)

  assert.deepEqual(await createGraduatedTradeIndexer({ pool: quiet.pool, connection: quiet.connection, verification: null, markets: quiet.markets }).runOnce(),
    [{ status: 'SKIPPED', code: 'VERIFICATION_RPC_REQUIRED' }])
})

test('one DAMM walk per market: its own lock, never the graduation lock, released even when the walk fails', async () => {
  const run = (locked, index) => {
    const queries = []
    const db = { query: async (sql, params) => { queries.push([sql.match(/pg_\w+/)[0], params[0]]); return { rows: [{ locked }] } } }
    return { queries, result: indexDammTradesLocked({ db, market: { githubRepoId: '1388219884' } }, index) }
  }
  assert.equal(dammTradesLockKey('1388219884'), 'damm-trades:1388219884')
  const walked = run(true, async () => ({ complete: true, transactions: 3 }))
  assert.deepEqual(await walked.result, { complete: true, transactions: 3 })
  assert.deepEqual(walked.queries, [['pg_try_advisory_lock', 'damm-trades:1388219884'], ['pg_advisory_unlock', 'damm-trades:1388219884']])
  let called = false
  const busy = run(false, async () => { called = true })
  assert.deepEqual(await busy.result, { complete: false, busy: true, transactions: 0 })
  assert.equal(called, false)
  assert.deepEqual(busy.queries, [['pg_try_advisory_lock', 'damm-trades:1388219884']])
  const failing = run(true, async () => { throw Error('DAMM_HISTORY_INCOMPLETE') })
  await assert.rejects(failing.result, /DAMM_HISTORY_INCOMPLETE/)
  assert.equal(failing.queries.at(-1)[0], 'pg_advisory_unlock')
})
