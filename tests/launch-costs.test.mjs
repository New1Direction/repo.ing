import test from 'node:test'
import assert from 'node:assert/strict'
import { launchCostBreakdown } from '../src/launch-costs.mjs'

test('launch costs separate buy, net account deposits and fee without double counting trading fees', () => {
  assert.deepEqual(launchCostBreakdown({ balance: 100_000_000, after: 69_985_000,
    networkFee: 15_000, initialBuyLamports: '10000000' }), {
    balance: '100000000', initialBuy: '10000000', networkFee: '15000', accountDeposits: '20000000', total: '30015000',
  })
  assert.equal(launchCostBreakdown({ balance: 100_000_000, after: 79_985_000,
    networkFee: 15_000, initialBuyLamports: '0' }).accountDeposits, '20000000')
})

test('missing, unsafe or contradictory simulation balances cannot show an invented estimate', () => {
  for (const after of [null, undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => launchCostBreakdown({ balance: 100_000_000, after,
      networkFee: 15_000, initialBuyLamports: '10000000' }), /unavailable/)
  }
  assert.throws(() => launchCostBreakdown({ balance: 100_000_000, after: 99_000_000,
    networkFee: 15_000, initialBuyLamports: '10000000' }), /balance changed/)
})
