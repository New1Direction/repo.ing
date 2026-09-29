import test from 'node:test'
import assert from 'node:assert/strict'
import { platformRevenueSummary } from '../src/platform-revenue.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'

const custodyTotal = BUYBACK_RECEIPTS.filter(r => r.source === 'custody').reduce((sum, r) => sum + BigInt(r.spentLamports), 0n)
function fakeDb({ allocatedBuyback, intentSpent = '0', imported = [], wallets = [BUYBACK_WALLETS.custody] }) {
  return { query: async sql => {
    if (sql.includes('from platform_revenue group')) return { rows: [] }
    if (sql.includes('group by phase')) return { rows: [] }
    if (sql.includes('from platform_revenue_allocations') && sql.includes('buyback_amount')) return { rows: [{ buyback: allocatedBuyback, liquidity: '0', treasury: '0' }] }
    if (sql.includes("from buyback_intents where status='settled'") && sql.includes('sum(amount)')) return { rows: [{ amount: intentSpent }] }
    if (sql.includes('not exists')) return { rows: [{ amount: '0' }] }
    if (sql.includes('signature from buyback_intents')) return { rows: imported.map(signature => ({ signature })) }
    if (sql.includes('distinct wallet from platform_fee_claims')) return { rows: wallets.map(wallet => ({ wallet })) }
    if (sql.includes('from buyback_receipts')) return { rows: [] }
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
