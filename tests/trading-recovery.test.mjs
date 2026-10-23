import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Connection } from '@solana/web3.js'
import { getTableColumns } from 'drizzle-orm'
import { markets } from '../src/db/schema.mjs'
import { createDammTrader } from '../src/canonical-damm-trade.mjs'
import { tradeRouter } from '../app/lib/trader.mjs'
import { tradingCustodyRecovery, tradingDatabase, tradingMarketLoader } from '../app/lib/trading-recovery.mjs'
import { POST } from '../app/api/trade/route.js'

const binding = {
  repoId: '1181927', mint: 'HPK3tWDTTo2cVAH2euTFm6iZtDv7hC7LPuXHQKNZbFpq',
  curve: 'BQLHSwtHk2X451juZfWfa3TFggcUrWVnCc8MLPagtfRd',
  config: '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M',
  previousOwner: 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1',
  owner: '11111111111111111111111111111111',
}
const manifest = { version: 1, poolCreators: [binding], positions: [] }

test('trading-only image loads the committed custody file without an oversized environment value and still requires its exact digest', () => {
  process.env.EXISTING_MARKET_TRADING_ONLY = 'true'
  delete process.env.TRADING_CUSTODY_RECOVERY_JSON
  try {
    process.env.TRADING_CUSTODY_RECOVERY_SHA256 = '2c31354ba8009acb0da1319b068f479216b0615120328510cba50665f0ecd888'
    const recovered = tradingCustodyRecovery()
    assert.equal(recovered.poolCreators.length, 77)
    assert.equal(recovered.positions.length, 4)
    assert(recovered.poolCreators.every(row => row.owner === '3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs'))
    process.env.TRADING_CUSTODY_RECOVERY_SHA256 = '0'.repeat(64)
    assert.throws(() => tradingCustodyRecovery(), /custody.*binding/i)
    delete process.env.TRADING_CUSTODY_RECOVERY_SHA256
    assert.throws(() => tradingCustodyRecovery(), /custody.*binding/i)
  } finally {
    delete process.env.EXISTING_MARKET_TRADING_ONLY
    delete process.env.TRADING_CUSTODY_RECOVERY_SHA256
  }
})

test('trading-only router admits only the reviewed market identity and exact config set', async () => {
  process.env.EXISTING_MARKET_TRADING_ONLY = 'true'
  process.env.DBC_LEGACY_CONFIGS = ''
  const market = { id: '1', githubRepoId: binding.repoId, mint: binding.mint, pool: binding.curve,
    creatorWallet: binding.previousOwner, status: 'confirmed', indexedAt: new Date().toISOString(), launchFinality: 'finalized' }
  let row = market, reads = 0
  const pool = { query: async () => {
    reads++
    return { rows: row ? [Object.keys(getTableColumns(markets)).map(key => row[key] ?? null)] : [] }
  } }
  try {
    const load = tradingMarketLoader(pool, binding.config, manifest)
    assert.equal((await load(binding.repoId)).mint, binding.mint)
    await assert.rejects(load('9999999'), /reviewed existing-market allowlist/)
    assert.equal(reads, 1, 'unknown repository is refused before database or chain reads')
    for (const patch of [null, { mint: binding.owner }, { pool: binding.owner }, { creatorWallet: binding.owner },
      { status: 'pending' }, { launchFinality: 'confirmed' }, { indexedAt: null }, { quoteMint: binding.owner },
      { transferHookProgram: binding.owner }, { bundleId: '1' }]) {
      row = patch === null ? null : { ...market, ...patch }
      await assert.rejects(load(binding.repoId), /reviewed existing-market allowlist/)
    }
    process.env.DBC_LEGACY_CONFIGS = binding.owner
    assert.throws(() => tradingMarketLoader(pool, binding.config, manifest), /reviewed config allowlist/)
    process.env.DBC_LEGACY_CONFIGS = ''
    assert.throws(() => tradingMarketLoader(pool, binding.owner, manifest), /reviewed config allowlist/)
  } finally {
    delete process.env.EXISTING_MARKET_TRADING_ONLY
    delete process.env.DBC_LEGACY_CONFIGS
  }
})

test('trading-only preparation cannot submit without a separate live-stage setting', async () => {
  process.env.EXISTING_MARKET_TRADING_ONLY = 'true'
  try {
    for (const stage of [undefined, 'review', 'TRUE', 'disabled']) {
      if (stage === undefined) delete process.env.EXISTING_MARKET_TRADING_STAGE
      else process.env.EXISTING_MARKET_TRADING_STAGE = stage
      const response = await POST(new Request('https://repo.ing/api/trade', {
        method: 'POST', body: JSON.stringify({ action: 'submit' }),
      }))
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error, 'TRADING_EXECUTION_DISABLED')
    }
  } finally {
    delete process.env.EXISTING_MARKET_TRADING_ONLY
    delete process.env.EXISTING_MARKET_TRADING_STAGE
  }
})

test('trading-only mode never falls back to the public database credential', () => {
  process.env.EXISTING_MARKET_TRADING_ONLY = 'true'
  globalThis.__gitfunPool = { reader: true }
  try {
    assert.throws(() => tradingDatabase(), /Trading database is not configured/)
    process.env.TRADING_DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
    globalThis.__repoingTradingPool = { trader: true }
    assert.equal(tradingDatabase(), globalThis.__repoingTradingPool)
    assert.notEqual(tradingDatabase(), globalThis.__gitfunPool)
  } finally {
    delete process.env.EXISTING_MARKET_TRADING_ONLY
    delete process.env.TRADING_DATABASE_URL
    delete globalThis.__gitfunPool
    delete globalThis.__repoingTradingPool
  }
})

test('graduated trading validates recovery bindings before any chain access', () => {
  assert.throws(() => createDammTrader({ pool: {}, connection: new Connection('http://127.0.0.1:1'),
    config: '11111111111111111111111111111111', custodyRecovery: { version: 999 } }), /custody binding/)
})

test('trading-only startup requires pinned public custody bindings, including on a warm router', () => {
  process.env.EXISTING_MARKET_TRADING_ONLY = 'true'
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
  process.env.DBC_CONFIG = binding.config
  globalThis.__gitfunPool = {}
  globalThis.__gitfunTrader = () => {}
  globalThis.__gitfunTraderConfig = process.env.DBC_CONFIG
  try {
    assert.throws(() => tradeRouter(), /custody.*binding/i)
    process.env.TRADING_CUSTODY_RECOVERY_JSON = JSON.stringify(manifest)
    process.env.TRADING_CUSTODY_RECOVERY_SHA256 = '0'.repeat(64)
    assert.throws(() => tradeRouter(), /custody.*binding/i)
    process.env.TRADING_CUSTODY_RECOVERY_SHA256 = createHash('sha256').update(process.env.TRADING_CUSTODY_RECOVERY_JSON).digest('hex')
    process.env.TRADING_DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
    globalThis.__repoingTradingPool = {}
    assert.doesNotThrow(() => tradeRouter())
    process.env.TRADING_CUSTODY_RECOVERY_JSON += ' '
    assert.throws(() => tradeRouter(), /custody.*binding/i)
  } finally {
    for (const key of ['EXISTING_MARKET_TRADING_ONLY', 'TRADING_DATABASE_URL', 'DATABASE_URL', 'DBC_CONFIG', 'TRADING_CUSTODY_RECOVERY_JSON', 'TRADING_CUSTODY_RECOVERY_SHA256']) delete process.env[key]
    delete globalThis.__repoingTradingPool
    delete globalThis.__gitfunTraderCustodyDigest
    delete globalThis.__gitfunPool
    delete globalThis.__gitfunTrader
    delete globalThis.__gitfunTraderConfig
  }
})
