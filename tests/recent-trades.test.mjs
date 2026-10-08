import test from 'node:test'
import assert from 'node:assert/strict'
import { recentTrades, recentTradeSol, recentTradeTokens, recentTradeAge, solscanTx } from '../app/lib/recent-trades.mjs'
import { referralStatus } from '../app/lib/referral.mjs'

const sig = n => `${'5'.repeat(86)}${'ABCDEFGHJKLMNPQRSTUV'[n]}`
const trade = (n, extra = {}) => ({ signature: sig(n), direction: n % 2 ? 'sell' : 'buy', tradedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), solLamports: '1500000000', tokenBaseUnits: '2500000', ...extra })

test('recent trades show the newest ten first from the chart\'s oldest-first list', () => {
  const list = recentTrades(Array.from({ length: 14 }, (_, n) => trade(n)))
  assert.equal(list.length, 10)
  assert.equal(list[0].signature, sig(13))
  assert.equal(list.at(-1).signature, sig(4))
  assert.deepEqual(recentTrades(null), [])
  assert.equal(recentTrades([trade(1)], 3).length, 1)
})

test('recent trades skip rows without a valid direction, signature or time', () => {
  const list = recentTrades([trade(0), trade(1, { direction: 'fee' }), trade(2, { signature: 'bad' }), trade(3, { tradedAt: 'nope' }), null])
  assert.deepEqual(list.map(row => row.signature), [sig(0)])
})

test('recent trade amounts use exact base units and tolerate missing token amounts', () => {
  assert.equal(recentTradeSol(trade(0)), '1.5 SOL')
  assert.equal(recentTradeSol(trade(0, { solLamports: null })), '—')
  assert.equal(recentTradeTokens(trade(0)), '2.5')
  assert.equal(recentTradeTokens(trade(0, { tokenBaseUnits: '9775865476267' })), '9,775,865.47')
  assert.equal(recentTradeTokens(trade(0, { tokenBaseUnits: '9999' })), '<0.01')
  assert.equal(recentTradeTokens(trade(0, { tokenBaseUnits: null })), null)
  assert.equal(recentTradeTokens(trade(0, { tokenBaseUnits: '1.5' })), null)
})

test('recent trade age and Solscan link', () => {
  const row = trade(0)
  assert.equal(recentTradeAge(row, Date.parse(row.tradedAt) + 30_000), 'just now')
  assert.equal(recentTradeAge(row, Date.parse(row.tradedAt) + 5 * 60_000), '5m ago')
  assert.equal(recentTradeAge({ tradedAt: 'x' }, Date.now()), '')
  assert.equal(solscanTx(row.signature), `https://solscan.io/tx/${row.signature}`)
})

test('referral status accepts only well-formed payloads', () => {
  assert.deepEqual(referralStatus({ enabled: true, earningsLamports: '42', setupLamports: '2039280', extra: 1 }), { enabled: true, earningsLamports: '42', setupLamports: '2039280', free: false })
  assert.equal(referralStatus({ enabled: false, earningsLamports: '0', setupLamports: '2039280', free: true }).free, true, 'repo.ing pays the setup')
  assert.equal(referralStatus({ enabled: false, earningsLamports: '0', setupLamports: '2039280', free: 'yes' }).free, false)
  assert.equal(referralStatus({ enabled: 'yes', earningsLamports: '42', setupLamports: '1' }), null)
  assert.equal(referralStatus({ enabled: false, earningsLamports: '-1', setupLamports: '1' }), null)
  assert.equal(referralStatus(null), null)
})
