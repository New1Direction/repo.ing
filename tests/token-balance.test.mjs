import assert from 'node:assert/strict'
import test from 'node:test'
import { sumTokenAccountBalances, sellAmountForPercent, tokenBalanceLabel } from '../app/lib/token-balance.mjs'

const account = amount => {
  const data = Buffer.alloc(8)
  data.writeBigUInt64LE(BigInt(amount))
  return { account: { data } }
}

test('sums every token account owned by the wallet', () => {
  assert.equal(sumTokenAccountBalances([account(1000000), account(250000)]), '1250000')
  assert.equal(sumTokenAccountBalances([]), '0')
  assert.throws(() => sumTokenAccountBalances([{ account: { data: Buffer.alloc(7) } }]), /Unexpected token account/)
})

test('sell shortcuts use exact base units and produce an input without grouping commas', () => {
  const balance = '9775865476267'
  assert.equal(sellAmountForPercent(balance, 25), '2443966.369066')
  assert.equal(sellAmountForPercent(balance, 50), '4887932.738133')
  assert.equal(sellAmountForPercent(balance, 100), '9775865.476267')
  assert.equal(sellAmountForPercent('1', 25), '')
  assert.equal(sellAmountForPercent('1', 100), '0.000001')
})

test('balance label stays readable without hiding small nonzero balances', () => {
  assert.equal(tokenBalanceLabel('9775865476267'), '9,775,865.47')
  assert.equal(tokenBalanceLabel('1'), '<0.01')
  assert.equal(tokenBalanceLabel('0'), '0')
})
