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

test('sell shortcuts round down, stay exact beyond float precision and round-trip through parseUnits', async () => {
  const { parseUnits } = await import('../app/lib/format.mjs')
  assert.equal(sellAmountForPercent('3', 50), '0.000001')
  assert.equal(sellAmountForPercent('7', 25), '0.000001')
  assert.equal(sellAmountForPercent('1000000', 25), '0.25')
  assert.equal(sellAmountForPercent('0', 100), '')
  const huge = '18446744073709551615'
  assert.equal(sellAmountForPercent(huge, 100), '18446744073709.551615')
  assert.equal(sellAmountForPercent(huge, 25), '4611686018427.387903')
  assert.equal(sellAmountForPercent('123456789', 50, 9), '0.061728394')
  for (const percent of [25, 50, 100]) assert.ok(BigInt(parseUnits(sellAmountForPercent(huge, percent), 6)) <= BigInt(huge))
  assert.equal(parseUnits(sellAmountForPercent(huge, 100), 6), huge)
  assert.throws(() => sellAmountForPercent('100', 33), /Unsupported/)
})

test('balance label stays readable without hiding small nonzero balances', () => {
  assert.equal(tokenBalanceLabel('9775865476267'), '9,775,865.47')
  assert.equal(tokenBalanceLabel('1'), '<0.01')
  assert.equal(tokenBalanceLabel('0'), '0')
})
