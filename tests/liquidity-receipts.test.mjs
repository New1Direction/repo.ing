import test from 'node:test'
import assert from 'node:assert/strict'
import { LIQUIDITY_RECEIPTS, REPOING_POOL, liquidityTotals, protocolLiquidityAdded } from '../app/lib/liquidity-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'
import { liquidityReserveSummary, reconcileLiquidity } from '../src/liquidity-deployment.mjs'
import { evaluateReserveCoverage } from '../src/reserve-coverage.mjs'
import { revenueComparison } from '../src/operations-health.mjs'

test('protocol liquidity totals match the verified deposits and report lock state', () => {
  assert.deepEqual(liquidityTotals(), { solLamports: 1711400001n + 1741250001n + 995000001n + 995000001n, tokenBaseUnits: 3011505954141n + 2222128769339n + 1259651284748n + 613821656139n, allLocked: false })
  assert.equal(liquidityTotals(LIQUIDITY_RECEIPTS.map(receipt => ({ ...receipt, locked: true }))).allLocked, true)
})

test('liquidity receipts must target the canonical pool and never repeat', () => {
  const [receipt] = LIQUIDITY_RECEIPTS
  assert.throws(() => liquidityTotals([{ ...receipt, pool: 'Other111111111111111111111111111111111111111' }]), /Invalid liquidity receipt/)
  assert.throws(() => liquidityTotals([receipt, receipt]), /Duplicate liquidity receipt/)
  assert.equal(receipt.pool, REPOING_POOL)
})

// The team's manual deposits spend the policy's 20% liquidity share (owner decision 2026-10-08): /stats, the executor's budget,
// reserve coverage and the operator health page all see the allocation net of them (src/liquidity-deployment.mjs).
const MANUAL = 1711400001n + 1741250001n + 995000001n + 995000001n
const ledger = ({ allocated = '0', committed = '0', settled = '0', graduated = true, invalid = 0 } = {}) => {
  const asked = []
  return { asked, async query(sql, params) {
    asked.push({ sql, params })
    if (/from platform_revenue_allocations/.test(sql)) return { rows: [{ amount: allocated }] }
    if (/as committed/.test(sql)) return { rows: [{ committed, settled, failed: '0', open: 0 }] }
    if (/from graduation_events/.test(sql)) return { rows: graduated ? [{ '?column?': 1 }] : [] }
    if (/count\(\*\)::int as n from liquidity_intents/.test(sql)) return { rows: [{ n: invalid }] }
    throw Error(`unexpected query: ${sql.slice(0, 50)}`)
  } }
}

test('the remaining liquidity allocation subtracts every manual deposit, as /stats shows it (8.90 - 5.44 = 3.46 SOL)', async () => {
  const db = ledger({ allocated: '8898000000' })
  const summary = await liquidityReserveSummary(db)
  assert.deepEqual({ manual: summary.manual, remaining: summary.remaining, ahead: summary.ahead, intentReserve: summary.intentReserve },
    { manual: MANUAL.toString(), remaining: (8898000000n - MANUAL).toString(), ahead: '0', intentReserve: '8898000000' })
  assert.equal(summary.remaining, '3455349996')
  // Only $REPOING's own graduated pool in this ledger counts the receipts.
  assert.deepEqual(db.asked.find(query => /graduation_events/.test(query.sql)).params, [OFFICIAL_TOKEN.repoId, REPOING_POOL])
  // Protocol intents come off as well; the executor's budget is what is left of both.
  assert.equal((await liquidityReserveSummary(ledger({ allocated: '8898000000', committed: '1000000000' }))).remaining, (7898000000n - MANUAL).toString())
})

test('never below 0: deposits beyond the allocation are reported as ahead, and reconciliation still matches', async () => {
  for (const [allocated, committed] of [['0', '0'], ['5000000000', '0'], ['5442650004', '0'], ['6000000000', '1000000000']]) {
    const summary = await liquidityReserveSummary(ledger({ allocated, committed }))
    const left = BigInt(allocated) - BigInt(committed) - MANUAL
    assert.equal(summary.remaining, (left > 0n ? left : 0n).toString(), allocated)
    assert.equal(summary.ahead, (left < 0n ? -left : 0n).toString(), allocated)
    assert.ok(BigInt(summary.remaining) >= 0n)
  }
  // Manual deposits ahead of the policy are allowed (as buybacks ahead are); protocol intents beyond it are not.
  assert.equal((await reconcileLiquidity(ledger({ allocated: '1000000000' }))).status, 'MATCH')
  const over = await reconcileLiquidity(ledger({ allocated: '1000000000', committed: '1000000001', graduated: false }))
  assert.deepEqual([over.status, over.problems], ['MISMATCH', ['Liquidity reserve is negative']])
})

test('a ledger that does not record $REPOING graduating into its pool (tests, devnet) counts no manual deposit', async () => {
  const summary = await liquidityReserveSummary(ledger({ allocated: '8898000000', graduated: false }))
  assert.deepEqual([summary.manual, summary.remaining, summary.ahead], ['0', '8898000000', '0'])
  const none = ledger({ allocated: '8898000000' })
  assert.equal((await liquidityReserveSummary(none, { receipts: [] })).remaining, '8898000000')
  assert.equal(none.asked.some(query => /graduation_events/.test(query.sql)), false, 'no receipts: nothing to look up')
})

test('reserve coverage and the operator health page use the same net figures', async () => {
  const summary = await liquidityReserveSummary(ledger({ allocated: '8898000000', settled: '0' }))
  const required = evaluateReserveCoverage({ status: 'MATCH', buybackReserve: '0', liquidityReserve: summary.remaining, unallocated: '0',
    custodyWallets: ['FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy'] }, [0, 1].map(() => ({ wallet: 'FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy',
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', slot: 451300000, balance: '3455349996' })))
  assert.deepEqual([required.status, required.required], ['COVERED', '3455349996'])
  const revenue = { claimed: { total: '0' }, available: '0', allocated: { buyback: '0', liquidity: '8898000000', treasury: '0', total: '8898000000' },
    spent: '0', buybackReserve: '0', activePolicy: null }
  const health = revenueComparison(revenue, { ...summary, settled: '100' }, { custody: '0', team: '0', total: '0', count: 0 })
  assert.deepEqual(health.liquidity, { allocated: '8898000000', added: (MANUAL + 100n).toString(), protocol: '100', manual: MANUAL.toString(), open: 0,
    owed: (8898000000n - MANUAL - 100n).toString() })
})

test('the graduation panel adds the manual deposits to $REPOING pool\'s protocol liquidity, and only there', () => {
  assert.equal(protocolLiquidityAdded(REPOING_POOL), MANUAL.toString())
  assert.equal(protocolLiquidityAdded(REPOING_POOL, '1000'), (MANUAL + 1000n).toString())
  for (const settled of [null, undefined, '1000']) {
    assert.equal(protocolLiquidityAdded('OtherPool1111111111111111111111111111111111', settled), settled, `other pools unchanged: ${settled}`)
  }
  assert.equal(protocolLiquidityAdded(REPOING_POOL, null, []), null)
})
