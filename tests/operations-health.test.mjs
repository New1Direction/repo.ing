import test from 'node:test'
import assert from 'node:assert/strict'
import { buybackTotals, classifyWalletBalance, healthWallets, loadOperationsHealth, migrationStatus, revenueComparison } from '../src/operations-health.mjs'
import { OPERATING_WALLETS } from '../src/operating-wallet-alerts.mjs'
import { createCspStats } from '../app/lib/csp-report.mjs'

const addresses = { creator: 'Creator1111111111111111111111111111111111111', partner: 'Partner1111111111111111111111111111111111111', custody: 'Custody111111111111111111111111111111111111', team: 'Team11111111111111111111111111111111111111111' }

test('wallet thresholds reuse the OPS_WALLET_LOW minimums and are strict', () => {
  const [creator, partner, custody] = healthWallets(addresses, { OPS_PAYOUT_WALLET: addresses.creator, OPS_COLLECTION_WALLET: 'elsewhere' })
  assert.equal(creator.minimumLamports, OPERATING_WALLETS.find(w => w.key === 'OPS_PAYOUT_WALLET').minimumLamports)
  assert.equal(partner.minimumLamports, OPERATING_WALLETS.find(w => w.key === 'OPS_COLLECTION_WALLET').minimumLamports)
  assert.deepEqual([creator.monitored, partner.monitored, custody.monitored], ['match', 'different', null])
  assert.equal(healthWallets(addresses, {})[0].monitored, 'unset')
  assert.equal(classifyWalletBalance('29999999', creator.minimumLamports), 'low')
  assert.equal(classifyWalletBalance('30000000', creator.minimumLamports), 'ok')
  assert.equal(classifyWalletBalance('0', null), 'unmonitored')
  assert.equal(classifyWalletBalance(null, '1'), 'unknown')
})

test('migration status counts journal entries newer than the latest applied migration', () => {
  const journal = { entries: [{ tag: '0000_a', when: 100 }, { tag: '0001_b', when: 200 }, { tag: '0002_c', when: 300 }] }
  assert.deepEqual(migrationStatus(journal, { count: 3, latest: '300' }).status, 'UP_TO_DATE')
  const behind = migrationStatus(journal, { count: 2, latest: '200' })
  assert.equal(behind.status, 'PENDING'); assert.deepEqual(behind.pending, ['0002_c']); assert.equal(behind.latestAppliedTag, '0001_b')
  assert.deepEqual(migrationStatus(journal, { count: 0, latest: null }).pending, ['0000_a', '0001_b', '0002_c'])
})

test('csp stats aggregate hosts and directives, bounded to the last reports', () => {
  let t = 0
  const stats = createCspStats({ maxReports: 2, maxKeys: 2, now: () => t++ })
  stats.record([{ directive: 'script-src-elem', blocked: 'https://evil.example/x.js', page: 'https://repo.ing/' },
    { directive: 'script-src-elem', blocked: 'https://evil.example/y.js', page: 'https://repo.ing/' },
    { directive: 'img-src', blocked: 'inline', page: 'https://repo.ing/a' },
    { directive: 'connect-src', blocked: 'wss://third.example/ws', page: 'https://repo.ing/b' }])
  const snap = stats.snapshot()
  assert.equal(snap.total, 4)
  assert.deepEqual(snap.hosts, [{ key: 'evil.example', count: 2 }, { key: 'inline', count: 1 }])
  assert.deepEqual(snap.directives, [{ key: 'script-src-elem', count: 2 }, { key: 'img-src', count: 1 }])
  assert.deepEqual(snap.recent.map(r => r.blocked), ['wss://third.example/ws', 'inline'])
})

test('revenue comparison highlights liquidity owed but not added', () => {
  const revenue = { claimed: { total: '1000' }, available: '0', allocated: { buyback: '600', liquidity: '200', treasury: '200', total: '1000' }, spent: '0', buybackReserve: '600', activePolicy: null }
  const buybacks = buybackTotals([{ source: 'custody', spentLamports: '500' }, { source: 'team', spentLamports: '70' }])
  const result = revenueComparison(revenue, { settled: '50', open: 0 }, buybacks)
  assert.deepEqual(result.buybacks, { custody: '500', team: '70', total: '570', count: 2 })
  assert.equal(result.liquidity.owed, '150'); assert.equal(result.buybackAllocatedNotDisclosed, '100')
})

test('loader returns per-section errors without throwing or leaking driver messages', async () => {
  const logs = []
  const db = { async query(sql) {
    if (sql.includes('from markets')) return { rows: [{ repoId: '1003272694', fullName: 'WILDCATZWEB3/Sollend-wallet', status: 'submitted', mint: null, pool: null, signature: null, createdAt: new Date(0) }] }
    if (sql.includes('__drizzle_migrations')) throw Object.assign(Error('relation does not exist'), { code: '42P01' })
    throw Error('password=hunter2 connection refused')
  } }
  const health = await loadOperationsHealth({ db, now: () => 60_000, log: (...args) => logs.push(args),
    connection: { getBalance: async address => { if (address === addresses.partner) throw Error('rpc down'); return 1 } },
    wallets: () => healthWallets(addresses, {}), readToken: async () => '5', loadBuybacks: async () => [],
    cspStats: { snapshot() { throw Error('boom') } }, journal: { entries: [] } })
  assert.equal(health.launches.ok, true); assert.equal(health.launches.data[0].ageMs, 60_000)
  assert.deepEqual(health.alerts, { ok: false, error: 'Alerts is temporarily unavailable.' })
  assert.equal(health.revenue.ok, false)
  assert.deepEqual(health.migrations, { ok: false, error: 'drizzle.__drizzle_migrations not found' })
  assert.equal(health.csp.ok, false)
  assert.equal(health.wallets.ok, true)
  const [creator, partner, custody] = health.wallets.data
  assert.equal(creator.state, 'low'); assert.equal(partner.error, 'Balance unavailable'); assert.equal(custody.tokenBaseUnits, '5')
  assert.doesNotMatch(JSON.stringify([health, logs]), /hunter2/)
})

test('loader times out a hung section and reports missing configuration', async () => {
  const health = await loadOperationsHealth({ db: null, connection: { getBalance: () => new Promise(() => {}) }, timeoutMs: 20, log() {},
    wallets: () => healthWallets(addresses, {}), readToken: async () => '0', cspStats: createCspStats(), journal: { entries: [] } })
  assert.deepEqual(health.wallets, { ok: false, error: 'Timed out after 0.02s' })
  assert.deepEqual(health.launches, { ok: false, error: 'DATABASE_URL is not configured' })
  assert.equal(health.csp.ok, true)
})
