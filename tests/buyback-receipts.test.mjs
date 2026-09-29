import test from 'node:test'
import assert from 'node:assert/strict'
import { BUYBACK_RECEIPTS, BUYBACK_RECEIPTS_BY_TIME, BUYBACK_WALLETS, totalBuybackLamports } from '../app/lib/buyback-receipts.mjs'

test('buyback total splits into platform revenue (custody) and team wallet receipts', () => {
  assert.equal(totalBuybackLamports(), '13631837631')
  assert.equal(totalBuybackLamports(undefined, 'custody'), '7469505712')
  assert.equal(totalBuybackLamports(undefined, 'team'), '6162331919')
  assert.equal(BUYBACK_RECEIPTS.length, 8)
  assert.deepEqual(BUYBACK_RECEIPTS_BY_TIME.map(receipt => receipt.at), [...BUYBACK_RECEIPTS.map(receipt => receipt.at)].sort())
})

test('receipts must come from the wallet their source names, and never repeat', () => {
  const [custody] = BUYBACK_RECEIPTS.filter(receipt => receipt.source === 'custody')
  assert.throws(() => totalBuybackLamports([{ ...custody, wallet: BUYBACK_WALLETS.team }]), /Invalid buyback receipt/)
  assert.throws(() => totalBuybackLamports([{ ...custody, source: 'unknown' }]), /Invalid buyback receipt/)
  assert.throws(() => totalBuybackLamports([custody, custody]), /Duplicate buyback receipt/)
})
