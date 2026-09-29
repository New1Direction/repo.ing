import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createBuybackReceiptsJob } from '../src/buyback-receipts-job.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_SOURCES, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'

const TXS = JSON.parse(readFileSync(new URL('./fixtures/repoing-buyback-transactions.json', import.meta.url), 'utf8'))
const signer = raw => raw.transaction.message.accountKeys[0]
// Newest-first wallet histories built from the real fixtures.
const history = wallet => Object.values(TXS).filter(raw => signer(raw) === wallet)
  .map(raw => ({ signature: raw.transaction.signatures[0], slot: raw.slot, blockTime: raw.blockTime, err: raw.meta.err }))
  .sort((a, b) => b.slot - a.slot)

function fakeConnection(histories) {
  const calls = []
  return { calls, failSignatures: false, async getSignaturesForAddress(key, { limit, before, until }) {
    calls.push({ wallet: key.toBase58(), before, until })
    if (this.failSignatures) throw Error('RPC_UNAVAILABLE')
    const list = histories[key.toBase58()] ?? []
    let start = before ? list.findIndex(item => item.signature === before) + 1 : 0
    let end = until ? list.findIndex(item => item.signature === until) : list.length
    if (end < 0) end = list.length
    return list.slice(start, end).slice(0, limit)
  } }
}

function fakeDb() {
  const receipts = new Map(), cursors = new Map()
  return { receipts, cursors, failure: null, async query(text, params) {
    if (this.failure) throw this.failure
    if (text.startsWith('select last_signature')) return { rows: cursors.has(params[0]) ? [{ last_signature: cursors.get(params[0]).signature }] : [] }
    if (text.includes('insert into buyback_receipts')) {
      if (receipts.has(params[0])) return { rows: [] }
      receipts.set(params[0], params); return { rows: [{ signature: params[0] }] }
    }
    if (text.includes('insert into buyback_receipt_cursors')) {
      const current = cursors.get(params[0])
      if (!current || current.slot <= Number(params[2])) cursors.set(params[0], { signature: params[1], slot: Number(params[2]) })
      return { rows: [] }
    }
    throw Error(`unexpected query ${text}`)
  } }
}

function setup(extra = {}) {
  const histories = Object.fromEntries(BUYBACK_SOURCES.map(([, wallet]) => [wallet, history(wallet)]))
  const connection = fakeConnection(histories), db = fakeDb(), loaded = []
  const loadTransaction = async (_, signature) => {
    loaded.push(signature)
    if (loadTransaction.fail?.has(signature)) throw Error('RPC_UNAVAILABLE')
    return TXS[signature] ?? null
  }
  const job = createBuybackReceiptsJob({ pool: db, connection, loadTransaction, pageSize: 3, chunkSize: 2, ...extra })
  return { histories, connection, db, loaded, loadTransaction, job }
}
const expected = BUYBACK_RECEIPTS.map(receipt => receipt.signature).sort()

test('first run records every buyback, stops at the window, and advances cursors to the newest signature', async t => {
  const log = t.mock.method(console, 'log', () => {})
  const { job, db, loaded, histories } = setup()
  const results = await job.runOnce()
  assert.deepEqual([...db.receipts.keys()].sort(), expected)
  for (const known of BUYBACK_RECEIPTS) assert.deepEqual(db.receipts.get(known.signature).slice(0, 7),
    [known.signature, known.source, known.wallet, known.mint, known.spentLamports, known.tokenBaseUnits, known.at])
  for (const wallet of Object.values(BUYBACK_WALLETS)) assert.equal(db.cursors.get(wallet).signature, histories[wallet][0].signature)
  // Launch and early buys precede the window and are never fetched.
  for (const prefix of ['3tbwZgax', '3U4NMJFg', '23QNS75c']) assert.ok(!loaded.some(signature => signature.startsWith(prefix)))
  assert.equal(log.mock.callCount(), 11)
  assert.match(log.mock.calls.map(call => call.arguments[0]).join('\n'), /"signature":"phvk[^"]+","source":"custody","sol":"5"/)
  // The platform fee wallet is scanned too; it has no buybacks in the fixtures.
  assert.deepEqual(results.map(result => result.receipts.length).sort(), [0, 4, 7])
})

test('re-running is idempotent and reads only signatures above the cursor', async t => {
  t.mock.method(console, 'log', () => {})
  const { job, db, loaded, connection } = setup()
  await job.runOnce()
  loaded.length = 0
  const results = await job.runOnce()
  assert.deepEqual(loaded, [])
  assert.equal(db.receipts.size, 11)
  assert.deepEqual(results.map(result => result.scanned), [0, 0, 0])
  assert.ok(connection.calls.slice(-3).filter(call => call.wallet !== 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3').every(call => call.until))
  // Dropping a cursor re-scans history without duplicating receipts.
  db.cursors.clear()
  await job.runOnce()
  assert.equal(db.receipts.size, 11)
})

test('an RPC error stops the run without advancing past unprocessed signatures', async t => {
  t.mock.method(console, 'log', () => {})
  const { job, db, loadTransaction, connection, histories } = setup()
  const team = histories[BUYBACK_WALLETS.team].filter(item => Date.parse('2026-09-27T21:00:00Z') <= item.blockTime * 1000).reverse()
  loadTransaction.fail = new Set([team[2].signature])
  await assert.rejects(job.runOnce(), /RPC_UNAVAILABLE/)
  // Chunk size 2: the first chunk completed, the failing one did not.
  assert.equal(db.cursors.get(BUYBACK_WALLETS.team)?.signature, team[1].signature)
  loadTransaction.fail = null
  connection.failSignatures = true
  const before = new Map(db.cursors)
  await assert.rejects(job.runOnce(), /RPC_UNAVAILABLE/)
  assert.deepEqual(db.cursors, before)
  connection.failSignatures = false
  await job.runOnce()
  assert.deepEqual([...db.receipts.keys()].sort(), expected)
})

test('a missing transaction or a history backlog beyond the page budget fails closed', async t => {
  t.mock.method(console, 'log', () => {})
  const missing = setup()
  missing.loadTransaction.fail = null
  const [newest] = missing.histories[BUYBACK_WALLETS.custody]
  delete TXS[newest.signature]
  try { await assert.rejects(missing.job.runOnce(), /BUYBACK_TRANSACTION_UNAVAILABLE/) }
  finally { TXS[newest.signature] = JSON.parse(readFileSync(new URL('./fixtures/repoing-buyback-transactions.json', import.meta.url), 'utf8'))[newest.signature] }
  const backlog = setup({ pageSize: 1, maxPages: 2 })
  await assert.rejects(backlog.job.runOnce(), /BUYBACK_HISTORY_BACKLOG/)
  assert.equal(backlog.db.cursors.size, 0)
})

test('a missing table (42P01) no-ops and logs once; other database errors throw', async t => {
  const log = t.mock.method(console, 'log', () => {})
  const { job, db, connection, loaded } = setup()
  db.failure = Object.assign(Error('relation "buyback_receipt_cursors" does not exist'), { code: '42P01' })
  assert.deepEqual(await job.runOnce(), { skipped: 'TABLE_MISSING' })
  assert.deepEqual(await job.runOnce(), { skipped: 'TABLE_MISSING' })
  assert.deepEqual(log.mock.calls.map(call => call.arguments[0]), ['buyback receipts table missing; skipping'])
  assert.equal(connection.calls.length + loaded.length, 0)
  db.failure = Object.assign(Error('terminating connection'), { code: '57P01' })
  await assert.rejects(job.runOnce(), /terminating connection/)
})
