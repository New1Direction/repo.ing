import test from 'node:test'
import assert from 'node:assert/strict'
import { feesSinceBuyback, isAfter, lastBuyback, readBuybackStatus } from '../src/buyback-status.mjs'
import { formatAgo } from '../app/lib/buyback-summary.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { mergeBuybackReceipts } from '../app/lib/buyback-receipts-db.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

const POLICY = Object.freeze({ version: 1, buybackPermille: 600, liquidityPermille: 200 })
const buyback = (at, extra = {}) => ({ source: 'custody', signature: `sig-${at}`, at, spentLamports: '1', tokenBaseUnits: '1', ...extra })
const claim = (at, amount, extra = {}) => ({ at, amount, ...extra })

test('last buyback is the newest platform-revenue receipt; team buys never reset it', () => {
  assert.equal(lastBuyback(BUYBACK_RECEIPTS).signature, '4sM8EMrKN63Gu3YwkWvPjRMabANJKmq18J8yA5Qu3Phb6AqBxqMgrRkgAa56bRmNM4bmA2xnap9Fd2jqi5UQToWQ')
  assert.equal(lastBuyback([buyback('2026-09-29T02:00:00.000Z', { source: 'team' })]), null)
  assert.equal(lastBuyback([]), null)
  assert.equal(lastBuyback(undefined), null)
})

test('same-second receipts are ordered by slot when both carry one', () => {
  const early = buyback('2026-09-29T05:00:00.000Z', { signature: 'a', slot: '100' })
  const late = buyback('2026-09-29T05:00:00.000Z', { signature: 'b', slot: '101' })
  assert.equal(lastBuyback([late, early]).signature, 'b')
  assert.equal(lastBuyback([early, late]).signature, 'b')
  // Slot wins over a coarser timestamp; without both slots, time decides.
  assert.equal(isAfter({ at: '2026-09-29T04:59:59.000Z', slot: '102' }, late), true)
  assert.equal(isAfter({ at: '2026-09-29T05:00:01.000Z' }, late), true)
  assert.equal(isAfter({ at: '2026-09-29T05:00:00.000Z' }, late), false)
})

test('worker-detected receipts carry their slot through the shared merge', () => {
  const detected = { signature: 'Detected2222222222222222222222222222222222222222222222222222222222222222222222222', source: 'custody',
    wallet: BUYBACK_WALLETS.custody, mint: OFFICIAL_TOKEN.mint, spentLamports: '250000000', tokenBaseUnits: '1000000',
    slot: '400000000', at: '2026-09-30T00:00:00.000Z' }
  const last = lastBuyback(mergeBuybackReceipts([detected]))
  assert.equal(last.signature, detected.signature)
  assert.equal(last.slot, '400000000')
})

test('fees since the last buyback apply the policy buyback share; boundary claims are excluded', () => {
  const last = buyback('2026-09-29T01:35:02.000Z')
  const claims = [claim('2026-09-29T01:35:01.999Z', '5000000000'), claim('2026-09-29T01:35:02.000Z', '7000000000'),
    claim('2026-09-29T01:35:02.001Z', '1000000000'), claim('2026-09-29T03:00:00.000Z', '333')]
  assert.deepEqual(feesSinceBuyback(claims, last, POLICY),
    { basis: 'policy', permille: 600, lamports: String(600000000n + 199n), totalLamports: '1000000333', claims: 2 })
})

test('recorded allocations are used as-is; unallocated claims get the floored policy share', () => {
  const since = feesSinceBuyback([claim('2026-09-30T00:00:00.000Z', '1000', { buybackAmount: '550' }),
    claim('2026-09-30T00:00:01.000Z', '999', { buybackAmount: null })], null, POLICY)
  assert.equal(since.lamports, String(550 + 599))
  assert.equal(since.totalLamports, '1999')
})

test('without an active policy only the total is reported, labelled as total', () => {
  for (const policy of [null, undefined, { buybackPermille: 1200 }, { buybackPermille: 60.5 }])
    assert.deepEqual(feesSinceBuyback([claim('2026-09-30T00:00:00.000Z', '42')], null, policy),
      { basis: 'total', lamports: '42', totalLamports: '42', claims: 1 })
})

test('zero states: no claims, no buyback, zero-percent policy', () => {
  assert.deepEqual(feesSinceBuyback([], buyback('2026-09-29T00:00:00.000Z'), POLICY),
    { basis: 'policy', permille: 600, lamports: '0', totalLamports: '0', claims: 0 })
  assert.equal(feesSinceBuyback([claim('2020-01-01T00:00:00.000Z', '10')], null, POLICY).lamports, '6')
  assert.equal(feesSinceBuyback([claim('2026-09-30T00:00:00.000Z', '10')], null, { buybackPermille: 0 }).lamports, '0')
  assert.throws(() => feesSinceBuyback([claim('2026-09-30T00:00:00.000Z', '-1')], null, POLICY), /Invalid platform fee claim/)
  assert.throws(() => feesSinceBuyback([claim('not a date', '1')], null, POLICY), /Invalid platform fee claim/)
})

test('status read keeps the last buyback and withholds fees without a verified ledger', async t => {
  const last = lastBuyback(BUYBACK_RECEIPTS)
  assert.deepEqual(await readBuybackStatus(null, BUYBACK_RECEIPTS), { last, since: null, standing: null })
  const errors = t.mock.method(console, 'error', () => {})
  const failing = { async query() { throw Object.assign(Error('missing'), { code: '42P01' }) } }
  assert.deepEqual(await readBuybackStatus(failing, BUYBACK_RECEIPTS), { last, since: null, standing: null })
  assert.equal(errors.mock.callCount(), 1)
})

test('time ago floors to whole units', () => {
  const now = Date.parse('2026-09-29T12:00:00.000Z')
  assert.equal(formatAgo('2026-09-29T11:59:30.000Z', now), 'just now')
  assert.equal(formatAgo('2026-09-29T11:58:59.000Z', now), '1 minute ago')
  assert.equal(formatAgo('2026-09-29T09:00:01.000Z', now), '2 hours ago')
  assert.equal(formatAgo('2026-09-27T11:00:00.000Z', now), '2 days ago')
  assert.equal(formatAgo('2026-09-29T12:00:05.000Z', now), 'just now')
  assert.equal(formatAgo('nope', now), null)
})
