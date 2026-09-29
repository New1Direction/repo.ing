import test from 'node:test'
import assert from 'node:assert/strict'
import { BUYBACK_RECEIPTS, BUYBACK_RECEIPTS_BY_TIME, BUYBACK_WALLETS, totalBuybackLamports } from '../app/lib/buyback-receipts.mjs'
import { loadBuybackReceipts, mergeBuybackReceipts } from '../app/lib/buyback-receipts-db.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

test('buyback total splits into platform revenue (custody) and team wallet receipts', () => {
  assert.equal(totalBuybackLamports(), '17641659322')
  assert.equal(totalBuybackLamports(undefined, 'custody'), '7469505712')
  assert.equal(totalBuybackLamports(undefined, 'team'), '10172153610')
  assert.equal(BUYBACK_RECEIPTS.length, 11)
  assert.deepEqual(BUYBACK_RECEIPTS_BY_TIME.map(receipt => receipt.at), [...BUYBACK_RECEIPTS.map(receipt => receipt.at)].sort())
})

test('receipts must come from the wallet their source names, and never repeat', () => {
  const [custody] = BUYBACK_RECEIPTS.filter(receipt => receipt.source === 'custody')
  assert.throws(() => totalBuybackLamports([{ ...custody, wallet: BUYBACK_WALLETS.team }]), /Invalid buyback receipt/)
  assert.throws(() => totalBuybackLamports([{ ...custody, source: 'unknown' }]), /Invalid buyback receipt/)
  assert.throws(() => totalBuybackLamports([custody, custody]), /Duplicate buyback receipt/)
})

// Database row shape as loadBuybackReceipts selects it.
const detected = Object.freeze({ signature: 'Detected1111111111111111111111111111111111111111111111111111111111111111111111111',
  source: 'custody', wallet: BUYBACK_WALLETS.custody, mint: OFFICIAL_TOKEN.mint, spentLamports: '250000000',
  tokenBaseUnits: '1000000', blockTime: new Date('2026-09-29T05:00:00.000Z') })
const fakeDb = rows => ({ async query() { if (rows instanceof Error) throw rows; return { rows } } })

test('/stats receipts: static list plus detected rows, deduped, validated, sorted by time', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const [first] = BUYBACK_RECEIPTS
  const { at, ...firstRow } = first
  const receipts = await loadBuybackReceipts(fakeDb([
    detected,
    // Same signature as a verified receipt with different numbers: the verified receipt wins.
    { ...firstRow, spentLamports: '1', blockTime: new Date(at) },
    { ...detected, signature: 'WrongWallet', wallet: BUYBACK_WALLETS.team },
    { ...detected, signature: 'Zero', spentLamports: '0' },
    { ...detected, signature: 'OtherMint', mint: BUYBACK_WALLETS.team },
  ]))
  assert.equal(receipts.length, 12)
  assert.deepEqual(receipts.map(receipt => receipt.at), [...receipts.map(receipt => receipt.at)].sort())
  const { blockTime, ...fields } = detected
  assert.deepEqual(receipts.at(-1), { ...fields, at: blockTime.toISOString() })
  assert.equal(receipts.find(receipt => receipt.signature === first.signature), first)
  assert.equal(totalBuybackLamports(receipts), '17891659322')
  assert.equal(totalBuybackLamports(receipts, 'custody'), '7719505712')
  assert.equal(totalBuybackLamports(receipts, 'team'), '10172153610')
  assert.equal(errors.mock.callCount(), 4)
})

test('/stats receipts fall back to the verified list when the database or table is unavailable, logging once', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  assert.deepEqual(await loadBuybackReceipts(null), BUYBACK_RECEIPTS_BY_TIME)
  const missing = Object.assign(Error('relation "buyback_receipts" does not exist'), { code: '42P01' })
  assert.deepEqual(await loadBuybackReceipts(fakeDb(missing)), BUYBACK_RECEIPTS_BY_TIME)
  assert.deepEqual(await loadBuybackReceipts(fakeDb(Error('connection refused'))), BUYBACK_RECEIPTS_BY_TIME)
  assert.equal(errors.mock.callCount(), 1)
  assert.equal(mergeBuybackReceipts([]).length, 11)
})
