import test from 'node:test'
import assert from 'node:assert/strict'
import { formatWholeSol, repoingCase } from '../app/lib/repoing-case.mjs'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

const NOW = Date.parse('2026-10-03T06:16:00.000Z')
const receipt = (signature, source, spentLamports, tokenBaseUnits, at) =>
  ({ signature, source, wallet: BUYBACK_WALLETS[source], mint: OFFICIAL_TOKEN.mint, spentLamports, tokenBaseUnits, at })
const receipts = [
  receipt('sig-custody', 'custody', '23340000000', '60000000000000', '2026-10-02T12:00:00.000Z'),
  receipt('sig-team', 'team', '28220000000', '80180000000000', '2026-10-03T05:30:00.000Z'),
]
const status = { latest: receipts[1], last: receipts[0], since: { basis: 'policy', permille: 600, lamports: '0', totalLamports: '0', claims: 0 },
  standing: { owedLamports: '0', aheadLamports: '25150000000' } }
const totals = { volume: '6958730000000', trades: 12256, markets: 50 }
const pulse = { status: 'shipping', commits24h: 68, commits7d: 312, merged7d: 12, devs7d: 3 }

test('every verified figure becomes a fact, in order: policy, buybacks, volume, shipping', () => {
  assert.deepEqual(repoingCase({ status, receipts, totals, pulse, models: true, now: NOW }), [
    { id: 'policy', label: 'To buybacks', value: '60%', detail: "of every market's platform fees go to $REPOING buybacks",
      note: '25.15 SOL bought beyond that so far' },
    { id: 'buybacks', label: 'Bought back', value: '51.56 SOL', detail: '140.18M $REPOING, every buy on-chain',
      note: 'Last one 46 minutes ago' },
    { id: 'volume', label: 'Traded on repo.ing', value: '6,958 SOL', detail: 'across 50 markets. More trading, more buybacks.',
      note: 'Now open to Hugging Face models' },
    { id: 'shipping', label: 'Shipped today', value: '68 commits', detail: 'built in public on GitHub',
      note: '12 PRs merged this week' },
  ])
})

test('the policy share is shown only while the revenue ledger is verified, and the extra buybacks only when ahead', () => {
  const ids = facts => facts.map(fact => fact.id)
  assert.deepEqual(ids(repoingCase({ status: { ...status, since: null, standing: null }, receipts, totals, pulse, now: NOW })), ['buybacks', 'volume', 'shipping'])
  assert.deepEqual(ids(repoingCase({ status: { ...status, since: { basis: 'total', lamports: '0', totalLamports: '0' } }, now: NOW })), [])
  const due = repoingCase({ status: { ...status, standing: { owedLamports: '1000000000', aheadLamports: '0' } }, now: NOW })
  assert.deepEqual(due, [{ id: 'policy', label: 'To buybacks', value: '60%', detail: "of every market's platform fees go to $REPOING buybacks", note: null }])
})

test('buybacks need a valid published receipt; the last-one note needs a latest buyback', () => {
  assert.deepEqual(repoingCase({ receipts: [], now: NOW }), [])
  assert.deepEqual(repoingCase({ receipts: [{ ...receipts[0], mint: 'not-repoing' }], now: NOW }), [])
  const [fact] = repoingCase({ receipts, now: NOW })
  assert.equal(fact.value, '51.56 SOL')
  assert.equal(fact.note, null)
})

test('volume needs a positive total and markets; one market and no models read correctly', () => {
  assert.deepEqual(repoingCase({ totals: { volume: '0', markets: 50 } }), [])
  assert.deepEqual(repoingCase({ totals: { volume: '999999999', markets: 50 } }), [], 'under 1 SOL floors to 0 and is left out')
  assert.deepEqual(repoingCase({ totals: { volume: '5000000000', markets: 0 } }), [])
  assert.deepEqual(repoingCase({ totals: { volume: 'n/a', markets: 3 } }), [])
  assert.deepEqual(repoingCase({ totals: { volume: '2500000000', markets: 1 } }), [
    { id: 'volume', label: 'Traded on repo.ing', value: '2 SOL', detail: 'across 1 market. More trading, more buybacks.', note: null }])
})

test('shipping: commits today, else this week; merged pull requests as the note; nothing before GitHub was read', () => {
  const week = repoingCase({ pulse: { status: 'quiet', commits24h: 0, commits7d: 1, merged7d: 1 } })
  assert.deepEqual(week, [{ id: 'shipping', label: 'Shipped this week', value: '1 commit', detail: 'built in public on GitHub',
    note: '1 PR merged this week' }])
  assert.equal(repoingCase({ pulse: { ...pulse, merged7d: 0 } })[0].note, null)
  assert.deepEqual(repoingCase({ pulse: { status: 'pending' } }), [])
  assert.deepEqual(repoingCase({ pulse: { status: 'quiet', commits24h: 0, commits7d: 0, merged7d: 4 } }), [])
  assert.deepEqual(repoingCase(), [])
})

test('whole SOL is floored and never overstated; junk is rejected', () => {
  assert.equal(formatWholeSol('6958730000000'), '6,958')
  assert.equal(formatWholeSol('6958999999999.000'), '6,958')
  assert.equal(formatWholeSol('1000000000'), '1')
  assert.equal(formatWholeSol('-5'), null)
  assert.equal(formatWholeSol(null), null)
})
