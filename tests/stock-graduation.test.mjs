import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { migrationPosition } from '../src/graduated-fees.mjs'
import { assertStockGraduationConfig, stockGraduationProgress, stockMigrationPosition, stockQuoteOf } from '../src/stock-graduation.mjs'
import { createStockGraduationMonitor, stockGraduationError, stockGraduationPass } from '../src/stock-graduation-monitor.mjs'
import { resolveQuoteAsset } from '../src/quote-assets.mjs'

// Graduation of a stock-paired market (docs/STOCK_QUOTES.md), on the real migration of DOCUSAURUS / METAx from
// tests/stock-graduation-chain.test.mjs (mainnet's programs on a local validator). No RPC is touched.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/stock-damm-graduation.json', import.meta.url), 'utf8'))
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const METAX = new PublicKey(fixture.quoteMint), target = new PublicKey(fixture.dammPool), config = new PublicKey(fixture.market.config)
const market = { githubRepoId: fixture.market.repoId, repoId: fixture.market.repoId, mint: fixture.market.mint, pool: fixture.market.curve,
  creatorWallet: fixture.market.creator, quoteAssetId: 'meta-xstock', quoteMint: METAX.toBase58() }
const migration = () => normalizeFinalizedTransaction(structuredClone(fixture.transactions.migration), fixture.transactions.migration.transaction.signatures[0])
const dbcCoder = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed').state.getProgram().coder.accounts
const fixed = dbcCoder.decode('poolConfig', Buffer.from(fixture.accounts.find(account => account.address === fixture.market.config).data, 'base64'))

test('the migrate instruction proves the stock pool and both positions, with the stock as its quote; a SOL proof never does', () => {
  const proof = stockMigrationPosition(migration(), market, config, target, METAX)
  assert.ok(proof?.position && proof.partner.position && !proof.position.equals(proof.partner.position))
  assert.ok(proof.nftAccount && proof.nftMint && proof.partner.nftAccount && proof.partner.nftMint)
  // Every pinned account must be this market's: another mint, curve, config, pool or stock proves nothing.
  for (const [label, args] of [['mint', [{ ...market, mint: Keypair.generate().publicKey.toBase58() }, config, target, METAX]],
    ['curve', [{ ...market, pool: Keypair.generate().publicKey.toBase58() }, config, target, METAX]], ['config', [market, Keypair.generate().publicKey, target, METAX]],
    ['pool', [market, config, Keypair.generate().publicKey, METAX]], ['stock', [market, config, target, new PublicKey('XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX')]]]) {
    assert.equal(stockMigrationPosition(migration(), ...args), null, label)
  }
  // The quote mint is required and is never SOL; the SOL proof (src/graduated-fees.mjs) refuses this stock migration.
  for (const quoteMint of [null, undefined, NATIVE_MINT]) assert.throws(() => stockMigrationPosition(migration(), market, config, target, quoteMint), /STOCK_QUOTE_MINT_REQUIRED/)
  assert.equal(migrationPosition(migration(), market, config, target), null)
  const failed = migration()
  failed.meta.err = { InstructionError: [0, { Custom: 1 }] }
  assert.equal(stockMigrationPosition(failed, market, config, target, METAX), null)
})

test('only the stock launch config graduates here: the stock through Token-2022, DAMM v2, locked liquidity and the policy\'s creator share', () => {
  assertStockGraduationConfig(fixed, META)
  assert.throws(() => assertStockGraduationConfig(fixed, resolveQuoteAsset('msft-xstock', { repoId: '1', ownerId: '6154722', ownerType: 'Organization' }, { enabled: true })),
    /Unsupported graduated stock configuration/)
  for (const patch of [{ quoteTokenFlag: 0 }, { migrationOption: 0 }, { creatorPermanentLockedLiquidityPercentage: 0 }, { partnerPermanentLockedLiquidityPercentage: 49 }]) {
    assert.throws(() => assertStockGraduationConfig({ ...fixed, ...patch }, META), /Unsupported graduated stock configuration/, Object.keys(patch)[0])
  }
  assert.throws(() => assertStockGraduationConfig({ ...fixed, creatorTradingFeePercentage: 70 }, META), error => error.code === 'STOCK_POLICY_CONFIG_MISMATCH')
  assert.equal(fixed.migrationQuoteThreshold.toString(), '1400000000', '14 METAx, raw')
})

test('progress is in raw units of the stock, exact, and 100% is never graduation', () => {
  assert.deepEqual(stockGraduationProgress('1050000000', '1400000000'), { phase: 'CURVE', status: 'active', reserveBaseUnits: '1050000000',
    thresholdBaseUnits: '1400000000', remainingBaseUnits: '350000000', progressPercent: 75 })
  assert.deepEqual([stockGraduationProgress('1400000000', '1400000000').phase, stockGraduationProgress('1400000000', '1400000000').status], ['CURVE', 'migrating'])
  assert.deepEqual([stockGraduationProgress('1', '1400000000', true).phase, stockGraduationProgress('1', '1400000000', true).remainingBaseUnits], ['GRADUATED', '0'])
  assert.throws(() => stockGraduationProgress('1', '0'), /INVALID_THRESHOLD/)
  assert.throws(() => stockGraduationProgress('-1', '1'), /INVALID_THRESHOLD/)
  // Nothing here reads a SOL market.
  assert.equal(stockQuoteOf(market).symbol, 'METAx')
  assert.throws(() => stockQuoteOf({ ...market, quoteAssetId: null, quoteMint: null }), /STOCK_MARKET_REQUIRED/)
})

test('review codes are stable: a policy or quote error keeps its code, anything else is EVIDENCE_UNAVAILABLE', () => {
  assert.equal(stockGraduationError(Object.assign(Error('x'), { code: 'STOCK_DAMM_CUMULATIVE_DECREASED' })), 'STOCK_DAMM_CUMULATIVE_DECREASED')
  assert.equal(stockGraduationError(Error('RPC_DISAGREEMENT')), 'RPC_DISAGREEMENT')
  assert.equal(stockGraduationError(Object.assign(Error('relation does not exist'), { code: '42P01' })), 'EVIDENCE_UNAVAILABLE')
  assert.equal(stockGraduationError(Error('fetch failed')), 'EVIDENCE_UNAVAILABLE')
})

test('the stock job costs nothing until a stock-paired market exists; a hook needs a name and a run function', async () => {
  const quiet = Object.assign(Object.create(new Connection('http://127.0.0.1:1')), { getGenesisHash: async () => assert.fail('no RPC without a stock market'),
    getSlot: async () => assert.fail('no RPC without a stock market') })
  const monitor = createStockGraduationMonitor({ pool: { query: async sql => { assert.match(sql, /m\.quote_asset_id is not null$/); return { rows: [] } } },
    connection: quiet, verification: quiet, config: Keypair.generate().publicKey.toBase58() })
  assert.deepEqual(await monitor.runOnce(), [])
  for (const hook of [null, { name: 'reconcile' }, { run: async () => {} }]) assert.throws(() => monitor.addHook(hook), /needs a name and a run function/)
  monitor.addHook({ name: 'reconcile', run: async () => 'MATCH' })
})

test('the worker\'s stock pass never rejects: a hook\'s BigInt is logged as text, and a broken report or log is contained', async () => {
  // scripts/run-worker.mjs runs this pass un-awaited: a rejection would take every SOL job down with the worker.
  const lines = [], log = line => lines.push(line)
  const result = [{ repoId: '94911145', status: 'VERIFIED', hooks: { reconcile: { earned: 2001n, nested: [1n] } } }]
  assert.equal(await stockGraduationPass({ runOnce: async () => result }, log), false)
  assert.deepEqual(JSON.parse(lines.at(-1)).stockGraduation[0].hooks.reconcile, { earned: '2001', nested: ['1'] })
  assert.equal(await stockGraduationPass({ runOnce: async () => [{ repoId: '1', status: 'REVIEW', code: 'RPC_DISAGREEMENT' }] }, log), true)
  assert.equal(await stockGraduationPass({ runOnce: async () => { throw Error('down') } }, log), true)
  assert.deepEqual(JSON.parse(lines.at(-1)), { stockGraduationError: 'Stock graduation unavailable' })
  // A hook result that cannot be serialized (a cycle), or a log that throws, still resolves.
  const cycle = { repoId: '1', status: 'VERIFIED' }
  cycle.self = cycle
  assert.equal(await stockGraduationPass({ runOnce: async () => [cycle] }, log), true)
  assert.deepEqual(JSON.parse(lines.at(-1)), { stockGraduationError: 'STOCK_GRADUATION_REPORT_UNAVAILABLE' })
  assert.equal(await stockGraduationPass({ runOnce: async () => result }, () => { throw Error('stdout closed') }), true)
  // Nothing to report: no line.
  const before = lines.length
  assert.equal(await stockGraduationPass({ runOnce: async () => [] }, log), false)
  assert.equal(lines.length, before)
})
