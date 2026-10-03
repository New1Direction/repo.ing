import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { QUOTE_ERRORS, SOL_QUOTE, resolveQuoteAsset } from '../src/quote-assets.mjs'
import { stockConfigFor, stockQuoteConfigs } from '../src/quote-configs.mjs'
import { createMarketConfigResolver, createQuoteAwareConfigResolver } from '../src/market-config.mjs'
import { rewardStamps } from '../src/launch-coordinator.mjs'
import { buildLaunchCurve, buildStockLaunchCurve } from '../src/launch-curve.mjs'
import { resolveRepositoryOwner } from '../src/github.mjs'
import { launchPair, stockMintCheck, stockPairGuard } from '../app/lib/stock-launch.mjs'

const DOCUSAURUS = { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }
const META = resolveQuoteAsset('meta-xstock', DOCUSAURUS, { enabled: true })
const SOL_CONFIG = Keypair.generate().publicKey, META_CONFIG = Keypair.generate().publicKey
const env = configs => ({ STOCK_QUOTE_CONFIGS: JSON.stringify(configs) })
const code = expected => error => error.code === expected
const metaOwner = async () => ({ ownerId: '69631', ownerType: 'Organization' })
const usable = async () => {}
const deps = overrides => ({ solConfig: SOL_CONFIG.toBase58(), enabled: true, owner: metaOwner,
  configFor: id => id === 'meta-xstock' ? META_CONFIG : null, mintUsable: usable, ...overrides })
const body = extra => ({ action: 'prepare', repoId: DOCUSAURUS.repoId, quoteAssetId: 'meta-xstock', ...extra })

test('STOCK_QUOTE_CONFIGS: asset id → config, all or nothing', () => {
  assert.equal(stockQuoteConfigs({}).size, 0)
  assert.equal(stockQuoteConfigs({ STOCK_QUOTE_CONFIGS: ' ' }).size, 0)
  const configs = stockQuoteConfigs(env({ 'meta-xstock': META_CONFIG.toBase58() }))
  assert.ok(configs.get('meta-xstock').equals(META_CONFIG))
  assert.ok(stockConfigFor('meta-xstock', env({ 'meta-xstock': META_CONFIG.toBase58() })).equals(META_CONFIG))
  assert.equal(stockConfigFor('msft-xstock', env({ 'meta-xstock': META_CONFIG.toBase58() })), null)
  for (const bad of ['[]', '"x"', 'not json', JSON.stringify({ 'aapl-xstock': META_CONFIG.toBase58() }), JSON.stringify({ 'meta-xstock': 'nope' }),
    JSON.stringify({ 'meta-xstock': META_CONFIG.toBase58(), 'msft-xstock': META_CONFIG.toBase58() })]) {
    assert.throws(() => stockQuoteConfigs({ STOCK_QUOTE_CONFIGS: bad }), `refuses ${bad}`)
  }
})

test('the SOL resolver refuses stock-paired markets; the quote-aware one resolves both, only on the stock\'s own config', () => {
  const mint = Keypair.generate().publicKey
  const solMarket = { mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, SOL_CONFIG).toBase58(), quoteMint: null, quoteAssetId: null }
  const stockPool = deriveDbcPoolAddress(new PublicKey(META.mint), mint, META_CONFIG).toBase58()
  const stockMarket = { mint: mint.toBase58(), pool: stockPool, quoteAssetId: 'meta-xstock', quoteMint: META.mint, quoteRegistryVersion: 1 }
  const sol = createMarketConfigResolver(SOL_CONFIG.toBase58(), [])
  assert.ok(sol(solMarket).equals(SOL_CONFIG))
  assert.ok(sol({ mint: solMarket.mint, pool: solMarket.pool }).equals(SOL_CONFIG), 'rows without quote columns are SOL, as before')
  assert.throws(() => sol(stockMarket), /quote-aware/)
  const aware = createQuoteAwareConfigResolver(SOL_CONFIG.toBase58(), [], new Map([['meta-xstock', META_CONFIG]]))
  assert.ok(aware(solMarket).equals(SOL_CONFIG))
  assert.ok(aware(stockMarket).equals(META_CONFIG))
  assert.throws(() => aware({ ...stockMarket, pool: solMarket.pool }), /does not match its stock config/)
  assert.throws(() => createQuoteAwareConfigResolver(SOL_CONFIG.toBase58(), [], new Map())(stockMarket), /no registered config/)
  assert.throws(() => aware({ ...stockMarket, quoteMint: SOL_QUOTE.mint }), code(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH))
  // A SOL pool for the same mint never resolves as the stock market, nor the reverse.
  assert.throws(() => aware({ ...solMarket, pool: stockPool }), /does not match an approved DBC config/)
})

test('stock-paired markets carry none of the SOL-denominated rewards; SOL stamps are unchanged', () => {
  const settings = { builderAllocationEnabled: true, verificationBonusLamports: 250_000_000n }
  assert.deepEqual(rewardStamps(94911145n, settings), { builderAllocationVersion: 1, verificationBonusLamports: 250_000_000n })
  assert.deepEqual(rewardStamps(94911145n, { ...settings, quote: SOL_QUOTE }), { builderAllocationVersion: 1, verificationBonusLamports: 250_000_000n })
  assert.deepEqual(rewardStamps(94911145n, { ...settings, quote: META }), { builderAllocationVersion: null, verificationBonusLamports: null })
})

test('launch pair: SOL takes the SOL config untouched; a stock pair is decided from the owner, its config and its mint', async () => {
  assert.deepEqual(await launchPair({ action: 'prepare', repoId: DOCUSAURUS.repoId }, deps({ owner: async () => { throw Error('no GitHub for SOL') } })),
    { quote: SOL_QUOTE, config: SOL_CONFIG.toBase58() })
  assert.deepEqual(await launchPair(body({ quoteAssetId: 'sol' }), deps()), { quote: SOL_QUOTE, config: SOL_CONFIG.toBase58() })
  const stock = await launchPair(body(), deps())
  assert.deepEqual([stock.quote.symbol, stock.quote.mint, stock.config], ['METAx', META.mint, META_CONFIG.toBase58()])
})

test('launch pair refusals, each with its code, never SOL', async () => {
  const refused = async (overrides, extra, expected) => assert.rejects(launchPair(body(extra), deps(overrides)), code(expected))
  await refused({ enabled: false }, {}, QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET)
  await refused({ enabled: false }, { quoteAssetId: 'METAx' }, QUOTE_ERRORS.QUOTE_ASSET_INVALID)
  await refused({}, { quoteAssetId: 'METAx' }, QUOTE_ERRORS.QUOTE_ASSET_INVALID)
  await refused({}, { repoId: '4503599627370497' }, QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET)
  await refused({}, { trendRevision: 3 }, QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET)
  await refused({}, { agentDraft: 'draft' }, QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET)
  await refused({ owner: async () => ({ ownerId: '6154722', ownerType: 'Organization' }) }, {}, QUOTE_ERRORS.QUOTE_ASSET_MISMATCH)
  await refused({ owner: async () => ({ ownerId: '424242', ownerType: 'Organization' }) }, {}, QUOTE_ERRORS.COMPANY_MAPPING_NOT_FOUND)
  await refused({ configFor: () => null }, {}, QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET)
  await refused({ mintUsable: async () => { throw Object.assign(Error('paused'), { code: QUOTE_ERRORS.STOCK_ASSET_DISABLED }) } }, {}, QUOTE_ERRORS.STOCK_ASSET_DISABLED)
  await assert.rejects(launchPair(body(), deps({ owner: async () => { throw Error('GitHub unavailable') } })), /GitHub unavailable/)
})

test('the guard decides the pair again after reservation and after the wallet signed', async () => {
  const context = { repo: { githubRepoId: 94911145n }, stage: 'submit' }
  const guard = overrides => stockPairGuard(META, META_CONFIG.toBase58(), { enabled: () => true, owner: metaOwner,
    configFor: () => META_CONFIG, mintUsable: usable, ...overrides })
  await guard({})(context)
  await assert.rejects(guard({ enabled: () => false })(context), code(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET))
  await assert.rejects(guard({ owner: async () => ({ ownerId: '6154722', ownerType: 'Organization' }) })(context), code(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH))
  await assert.rejects(guard({ configFor: () => SOL_CONFIG })(context), code(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH))
  await assert.rejects(guard({ configFor: () => null })(context), code(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH))
  await assert.rejects(guard({ mintUsable: async () => { throw Error('Token transfers are paused by the issuer') } })(context), /paused/)
})

test('an unusable stock mint is refused as STOCK_ASSET_DISABLED with the reason', async () => {
  const missing = { getAccountInfo: async () => null, getEpochInfo: async () => ({ epoch: 900 }) }
  await assert.rejects(stockMintCheck(missing)(META), error => error.code === QUOTE_ERRORS.STOCK_ASSET_DISABLED && /METAx cannot be paired right now: Token mint account is unavailable/.test(error.message))
})

test('the owner GitHub reports now, by immutable id; never guessed', async () => {
  const github = owner => async url => ({ ok: true, status: 200, json: async () => ({ id: 94911145, private: false, owner, url }) })
  assert.deepEqual(await resolveRepositoryOwner('94911145', github({ login: 'facebook', id: 69631, type: 'Organization' })), { ownerId: '69631', ownerType: 'Organization' })
  for (const owner of [{ login: 'facebook' }, { id: '69631', type: 'Organization' }, { id: 69631 }, { id: 0, type: 'User' }]) {
    await assert.rejects(resolveRepositoryOwner('94911145', github(owner)), /incomplete owner identity/)
  }
  await assert.rejects(resolveRepositoryOwner('94911145', async () => ({ ok: true, status: 200, json: async () => ({ id: 1, owner: { id: 69631, type: 'Organization' } }) })), /identity mismatch/)
  await assert.rejects(resolveRepositoryOwner('94911145', async () => ({ ok: false, status: 404 })), /not found/)
  await assert.rejects(resolveRepositoryOwner('4503599627370497', github({ id: 69631, type: 'Organization' })))
  await assert.rejects(resolveRepositoryOwner('abc', github({ id: 69631, type: 'Organization' })), /Invalid repository/)
})

test('the stock curve keeps the launch-fee profile\'s terms with the stock\'s decimals and a threshold in that stock', () => {
  const curve = buildStockLaunchCurve({ quoteDecimals: 8, migrationQuoteThreshold: 14 })
  // Quote decimals live in the curve math: 14 whole METAx is 14 × 10^8 base units.
  assert.equal(curve.tokenDecimal, 6)
  assert.equal(curve.migrationQuoteThreshold.toString(), String(14n * 10n ** 8n))
  assert.deepEqual(curve.poolFees, buildLaunchCurve('launch-fee').poolFees, 'the same fees and launch-fee schedule as SOL launches')
  assert.equal(curve.enableFirstSwapWithMinFee, true)
  assert.equal(curve.creatorTradingFeePercentage, 71)
  assert.equal(curve.collectFeeMode, 0)
  assert.equal(curve.migrationOption, 1)
  assert.deepEqual([curve.partnerPermanentLockedLiquidityPercentage, curve.creatorPermanentLockedLiquidityPercentage], [50, 50])
  for (const bad of [{ quoteDecimals: 5, migrationQuoteThreshold: 14 }, { quoteDecimals: 8, migrationQuoteThreshold: 0 }, { quoteDecimals: 8, migrationQuoteThreshold: NaN }]) {
    assert.throws(() => buildStockLaunchCurve(bad))
  }
})
