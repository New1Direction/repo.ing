import assert from 'node:assert/strict'
import test from 'node:test'
import { canAffordBuy, sameAmount } from '../app/lib/quick-amounts.mjs'
import { DEFAULT_BUY_PRESETS } from '../app/lib/buy-presets.mjs'
import { sellAmountForPercent } from '../app/lib/token-balance.mjs'

test('buy presets default to 0.1, 0.5 and 1 SOL', () => {
  assert.deepEqual(DEFAULT_BUY_PRESETS, ['0.1', '0.5', '1'])
})

test('buy preset affordability uses exact lamports and leaves room for fees', () => {
  assert.equal(canAffordBuy('0.5', '500000001'), true)
  assert.equal(canAffordBuy('0.5', '500000000'), false)
  assert.equal(canAffordBuy('1', '0'), false)
  assert.equal(canAffordBuy('1', '18446744073709551615'), true)
})

test('buy presets stay enabled while the SOL balance is unknown', () => {
  assert.equal(canAffordBuy('1', null), true)
  assert.equal(canAffordBuy('1', undefined), true)
})

test('malformed preset amounts are never affordable', () => {
  for (const value of ['', '0', '-1', '.5', 'abc', '0.0000000001', null]) assert.equal(canAffordBuy(value, null), false)
})

test('active preset matches by base units, not string form', () => {
  assert.equal(sameAmount('0.50', '0.5', 9), true)
  assert.equal(sameAmount('1.000', '1', 9), true)
  assert.equal(sameAmount('0.51', '0.5', 9), false)
  assert.equal(sameAmount('', '0.5', 9), false)
  assert.equal(sameAmount('0.5.', '0.5', 9), false)
})

test('sell percentages round down in base units and 100% equals the full balance', () => {
  const balance = '18446744073709551615'
  assert.equal(sellAmountForPercent(balance, 100), '18446744073709.551615')
  assert.equal(sellAmountForPercent('3', 25), '')
  assert.equal(sellAmountForPercent('3', 50), '0.000001')
  assert.equal(sellAmountForPercent('7', 50), '0.000003')
  assert.equal(sameAmount(sellAmountForPercent(balance, 100), '18446744073709.551615', 6), true)
})
