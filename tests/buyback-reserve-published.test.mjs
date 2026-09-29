import test from 'node:test'
import assert from 'node:assert/strict'
import { platformRevenueSummary, CUSTODY_FUNDED_BY } from '../src/platform-revenue.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'

const custodyTotal = BUYBACK_RECEIPTS.filter(r => r.source === 'custody').reduce((sum, r) => sum + BigInt(r.spentLamports), 0n)
function fakeDb({ allocatedBuyback, intentSpent = '0', imported = [], wallets = Object.keys(CUSTODY_FUNDED_BY), detected = [] }) {
  return { query: async sql => {
    if (sql.includes('from platform_revenue group')) return { rows: [] }
    if (sql.includes('group by phase')) return { rows: [] }
    if (sql.includes('from platform_revenue_allocations') && sql.includes('buyback_amount')) return { rows: [{ buyback: allocatedBuyback, liquidity: '0', treasury: '0' }] }
    if (sql.includes("from buyback_intents where status='settled'") && sql.includes('sum(amount)')) return { rows: [{ amount: intentSpent }] }
    if (sql.includes('not exists')) return { rows: [{ amount: '0' }] }
    if (sql.includes('signature from buyback_intents')) return { rows: imported.map(signature => ({ signature })) }
    if (sql.includes('distinct wallet from platform_fee_claims')) return { rows: wallets.map(wallet => ({ wallet })) }
    if (sql.includes('from buyback_receipts')) return { rows: detected }
    if (sql.includes('platform_revenue_policies')) return { rows: [] }
    throw Error(`unexpected query: ${sql}`)
  } }
}

test('published custody buybacks reduce the reserve and overbuying is reported as ahead, not negative', async () => {
  const owed = await platformRevenueSummary(fakeDb({ allocatedBuyback: String(custodyTotal + 2_370_000_000n) }))
  assert.equal(owed.buybackReserve, '2370000000'); assert.equal(owed.buybackAhead, '0'); assert.equal(owed.publishedSpent, custodyTotal.toString())
  const ahead = await platformRevenueSummary(fakeDb({ allocatedBuyback: String(custodyTotal - 1_000_000_000n) }))
  assert.equal(ahead.buybackReserve, '0'); assert.equal(ahead.buybackAhead, '1000000000')
  assert.equal(BigInt(ahead.intentReserve) > 0n, true)
})

test('receipts from other wallets or already imported as intents are not double counted', async () => {
  const other = await platformRevenueSummary(fakeDb({ allocatedBuyback: '5000000000', wallets: ['SomeOtherCustodyWallet11111111111111111111'] }))
  assert.equal(other.publishedSpent, '0'); assert.equal(other.buybackReserve, '5000000000')
  const first = BUYBACK_RECEIPTS.find(r => r.source === 'custody')
  const importedOne = await platformRevenueSummary(fakeDb({ allocatedBuyback: String(custodyTotal * 2n), intentSpent: first.spentLamports, imported: [first.signature] }))
  assert.equal(BigInt(importedOne.publishedSpent), custodyTotal - BigInt(first.spentLamports))
  assert.equal(BigInt(importedOne.buybackReserve), custodyTotal)
})

test('the partner wallet that receives claims maps to the published custody buyback wallet', () => {
  assert.equal(CUSTODY_FUNDED_BY.H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3, BUYBACK_WALLETS.custody)
})

test('team-wallet buybacks count toward the policy only from the cutoff onward', async () => {
  const { TEAM_BUYBACKS_COUNT_FROM } = await import('../src/platform-revenue.mjs')
  const team = BUYBACK_RECEIPTS.find(r => r.source === 'team')
  assert.ok(team.at < TEAM_BUYBACKS_COUNT_FROM)
  const before = await platformRevenueSummary(fakeDb({ allocatedBuyback: String(custodyTotal + 1_000_000_000n) }))
  assert.equal(before.buybackReserve, '1000000000')
})

test('the 0.62 SOL team buy after the cutoff reduces what the policy still owes', async () => {
  const detected = [{ signature: '4zHQCDVVcQ1NzyLFqLWcoZeEzt29hWJ8aMJgHDbaXFNyg5w6733cEHb8kqYr6Uifr2Uu1MYxoCZsRRkKmdqdxStc', source: 'team',
    wallet: BUYBACK_WALLETS.team, mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', spentLamports: '620000000', tokenBaseUnits: '758932278545',
    slot: '1', blockTime: new Date('2026-09-29T23:10:17Z') }]
  const summary = await platformRevenueSummary(fakeDb({ allocatedBuyback: String(custodyTotal + 282_259_356n), detected }))
  assert.equal(summary.buybackReserve, '0'); assert.equal(summary.buybackAhead, String(620_000_000n - 282_259_356n))
})
