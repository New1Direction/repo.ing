import test from 'node:test'
import assert from 'node:assert/strict'
import { mintFacts, solUsdMinutes } from '../scripts/prices-job.mjs'

const mintAccount = (decimals, supply) => ({ data: { parsed: { type: 'mint', info: { decimals, supply } } } })

test('mint facts come from the mint account: real decimals and on-chain supply', () => {
  // Arrange / Act
  const facts = mintFacts('59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', mintAccount(6, '999850848836751'), 462560000)

  // Assert
  assert.deepEqual(facts, { mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', decimals: 6, supply: '999850848836751', slot: 462560000 })
})

test('an unreadable or non-mint account is refused, never defaulted', () => {
  assert.throws(() => mintFacts('m', null, 1), /MINT_UNREADABLE/)
  assert.throws(() => mintFacts('m', { data: { parsed: { type: 'account', info: {} } } }, 1), /MINT_UNREADABLE/)
  assert.throws(() => mintFacts('m', mintAccount(19, '1'), 1), /MINT_UNREADABLE/)
  assert.throws(() => mintFacts('m', mintAccount(6, '-5'), 1), /MINT_UNREADABLE/)
})

test('Coinbase candles become one SOL/USD close per UTC minute, oldest first', () => {
  // Arrange: Coinbase returns newest first as [time, low, high, open, close, volume]
  const candles = [[1793206200, 101, 102, 101.5, 101.09, 10], [1793206140, 100, 101, 100.5, 100.8, 5]]

  // Act
  const minutes = solUsdMinutes(candles)

  // Assert
  assert.deepEqual(minutes, [
    { minute: '2026-10-28T16:49:00.000Z', usd: '100.8' },
    { minute: '2026-10-28T16:50:00.000Z', usd: '101.09' },
  ])
})

test('a candle off the minute or without a positive close is refused', () => {
  assert.throws(() => solUsdMinutes([[1793206201, 1, 1, 1, 1, 1]]), /SOL_USD_UNREADABLE/)
  assert.throws(() => solUsdMinutes([[1793206200, 1, 1, 1, 0, 1]]), /SOL_USD_UNREADABLE/)
  assert.throws(() => solUsdMinutes({ message: 'rate limited' }), /SOL_USD_UNREADABLE/)
})
