import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { QUOTE_ERRORS, QUOTE_REGISTRY, SOL_QUOTE, companyForOwner, quoteAssetById, quoteOfMarket, quoteOptions, quoteStamp,
  resolveQuoteAsset, stockQuotesEnabled } from '../src/quote-assets.mjs'
import { TIP_TOKENS } from '../src/tip-tokens.mjs'

// facebook/docusaurus and microsoft/vscode as GitHub reports them (owner ids from GitHub's GET /orgs/<login>).
const DOCUSAURUS = { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }
const VSCODE = { repoId: '41881900', ownerId: '6154722', ownerType: 'Organization' }
const ON = { enabled: true }
const META_MINT = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const code = expected => error => error.code === expected
// A registry copy with one asset or company changed, for the disabled-state cases.
const variant = ({ asset = {}, company = {} }) => ({ ...QUOTE_REGISTRY,
  assets: QUOTE_REGISTRY.assets.map(entry => entry.assetId === 'meta-xstock' ? { ...entry, ...asset } : entry),
  companies: QUOTE_REGISTRY.companies.map(entry => entry.companyId === 'meta-platforms' ? { ...entry, ...company } : entry) })

test('the registry is explicit and well-formed: unique ids and mints, valid base58, every asset belongs to a listed company', () => {
  const { companies, assets, version } = QUOTE_REGISTRY
  assert.ok(Number.isInteger(version) && version >= 1)
  assert.equal(new Set(companies.map(c => c.companyId)).size, companies.length)
  assert.equal(new Set(companies.map(c => c.githubOwnerId)).size, companies.length)
  assert.equal(new Set(assets.map(a => a.assetId)).size, assets.length)
  assert.equal(new Set(assets.map(a => a.mint)).size, assets.length)
  for (const company of companies) assert.match(company.githubOwnerId, /^[1-9]\d*$/)
  for (const asset of assets) {
    assert.equal(new PublicKey(asset.mint).toBase58(), asset.mint)
    assert.ok(companies.some(c => c.companyId === asset.companyId), `${asset.assetId} has a company`)
    assert.match(asset.assetId, /^[a-z0-9][a-z0-9-]{1,31}$/)
    assert.notEqual(asset.mint, SOL_QUOTE.mint)
    assert.equal(asset.chain, 'solana')
    assert.ok(asset.provider)
  }
  assert.ok(Object.isFrozen(QUOTE_REGISTRY.assets[0]) && Object.isFrozen(QUOTE_REGISTRY.companies[0]))
})

test('every stock quote agrees with the tip allowlist on mint, decimals and token program', () => {
  for (const asset of QUOTE_REGISTRY.assets) {
    const tip = TIP_TOKENS.find(token => token.symbol === asset.symbol)
    assert.ok(tip, `${asset.symbol} is on the tip allowlist`)
    assert.deepEqual([tip.mint, tip.decimals, tip.program], [asset.mint, asset.decimals, asset.tokenProgram])
  }
})

test('facebook/docusaurus offers SOL and METAx (Meta Platforms); microsoft/vscode offers SOL and MSFTx', () => {
  assert.deepEqual(quoteOptions(DOCUSAURUS, ON), [
    { type: 'SOL', assetId: 'sol', symbol: 'SOL', eligible: true },
    { type: 'TOKENIZED_EQUITY', assetId: 'meta-xstock', symbol: 'METAx', ticker: 'META', company: 'Meta Platforms', githubOrg: 'facebook',
      provider: 'backed-xstocks', eligible: true },
  ])
  assert.deepEqual(quoteOptions(VSCODE, ON).map(option => option.symbol), ['SOL', 'MSFTx'])
})

test('SOL only: stock pairs off, an unmapped owner, a user account, an unconfirmed owner, a Hugging Face model', () => {
  const solOnly = options => assert.deepEqual(options.map(option => option.assetId), ['sol'])
  solOnly(quoteOptions(DOCUSAURUS))
  solOnly(quoteOptions({ repoId: '1296269', ownerId: '583231', ownerType: 'User' }, ON))
  solOnly(quoteOptions({ repoId: '1', ownerId: '9919', ownerType: 'Organization' }, ON))
  solOnly(quoteOptions({ ...DOCUSAURUS, ownerType: 'User' }, ON))
  solOnly(quoteOptions({ repoId: DOCUSAURUS.repoId, ownerId: null, ownerType: null }, ON))
  solOnly(quoteOptions({ ...DOCUSAURUS, repoId: '4503599627370497' }, ON))
  solOnly(quoteOptions(null, ON))
})

test('companies match by numeric owner id only: a renamed login keeps its pair, a squatter on the login gets none', () => {
  assert.equal(companyForOwner({ ownerId: '69631', ownerType: 'Organization' }).companyName, 'Meta Platforms')
  assert.equal(companyForOwner({ ownerId: 69631, ownerType: 'Organization' }).ticker, 'META')
  // GitHub would report a renamed facebook organization with the same id; the login plays no part.
  assert.equal(quoteOptions({ ...DOCUSAURUS, owner: 'meta-renamed' }, ON)[1].symbol, 'METAx')
  // Someone holding the "facebook" login with another id is not Meta.
  assert.equal(companyForOwner({ ownerId: '424242', ownerType: 'Organization', owner: 'facebook' }), null)
  for (const ownerId of ['069631', '69631.0', '-69631', '', undefined, 'abc']) assert.equal(companyForOwner({ ownerId, ownerType: 'Organization' }), null)
})

test('a launch resolves only a registry asset id, re-checked against the repository owner', () => {
  assert.equal(resolveQuoteAsset(undefined, DOCUSAURUS, ON), SOL_QUOTE)
  assert.equal(resolveQuoteAsset('sol', DOCUSAURUS), SOL_QUOTE)
  const meta = resolveQuoteAsset('meta-xstock', DOCUSAURUS, ON)
  assert.deepEqual([meta.symbol, meta.mint, meta.decimals, meta.companyName, meta.registryVersion],
    ['METAx', META_MINT, 8, 'Meta Platforms', QUOTE_REGISTRY.version])
  assert.equal(resolveQuoteAsset('msft-xstock', VSCODE, ON).symbol, 'MSFTx')
})

test('arbitrary tickers, mints, company names and malformed ids are refused; nothing falls back to SOL', () => {
  for (const input of ['METAx', 'META', 'Meta Platforms', META_MINT, 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'.toLowerCase().slice(0, 40),
    { assetId: 'meta-xstock' }, 7, '', ' meta-xstock', 'meta_xstock', 'x'.repeat(33)]) {
    assert.throws(() => resolveQuoteAsset(input, DOCUSAURUS, ON), error => [QUOTE_ERRORS.QUOTE_ASSET_INVALID, QUOTE_ERRORS.STOCK_ASSET_NOT_FOUND].includes(error.code),
      `refuses ${JSON.stringify(input)}`)
  }
  assert.throws(() => resolveQuoteAsset('metax', DOCUSAURUS, ON), code(QUOTE_ERRORS.STOCK_ASSET_NOT_FOUND))
  assert.throws(() => resolveQuoteAsset('aapl-xstock', DOCUSAURUS, ON), code(QUOTE_ERRORS.STOCK_ASSET_NOT_FOUND))
})

test('stock pairs off, a disabled asset or company, another company\'s stock or an unmapped owner each fail with their code', () => {
  assert.throws(() => resolveQuoteAsset('meta-xstock', DOCUSAURUS), code(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET))
  assert.throws(() => resolveQuoteAsset('meta-xstock', DOCUSAURUS, { enabled: true, registry: variant({ asset: { enabled: false } }) }),
    code(QUOTE_ERRORS.STOCK_ASSET_DISABLED))
  assert.throws(() => resolveQuoteAsset('meta-xstock', DOCUSAURUS, { enabled: true, registry: variant({ company: { enabled: false } }) }),
    code(QUOTE_ERRORS.COMPANY_MAPPING_NOT_FOUND))
  assert.throws(() => resolveQuoteAsset('msft-xstock', DOCUSAURUS, ON), code(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH))
  assert.throws(() => resolveQuoteAsset('meta-xstock', { repoId: '1', ownerId: '9919', ownerType: 'Organization' }, ON),
    code(QUOTE_ERRORS.COMPANY_MAPPING_NOT_FOUND))
  assert.throws(() => resolveQuoteAsset('meta-xstock', { ...DOCUSAURUS, ownerId: null }, ON), code(QUOTE_ERRORS.COMPANY_MAPPING_NOT_FOUND))
  assert.throws(() => resolveQuoteAsset('meta-xstock', { ...DOCUSAURUS, repoId: '4503599627370497' }, ON), code(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET))
  // A disabled asset is shown as not eligible (with its code) rather than silently dropped, and SOL stays first.
  assert.deepEqual(quoteOptions(DOCUSAURUS, { enabled: true, registry: variant({ asset: { enabled: false } }) }).map(o => [o.symbol, o.eligible, o.reason]),
    [['SOL', true, undefined], ['METAx', false, QUOTE_ERRORS.STOCK_ASSET_DISABLED]])
})

test('a market\'s stamp: null columns for SOL; the exact asset, mint and registry version for a stock', () => {
  assert.deepEqual(quoteStamp(SOL_QUOTE), { quoteAssetId: null, quoteMint: null, quoteRegistryVersion: null })
  assert.deepEqual(quoteStamp(resolveQuoteAsset('meta-xstock', DOCUSAURUS, ON)),
    { quoteAssetId: 'meta-xstock', quoteMint: META_MINT, quoteRegistryVersion: QUOTE_REGISTRY.version })
})

test('historical markets keep resolving through their stamp, even after the asset is disabled; a mismatched stamp fails', () => {
  assert.equal(quoteOfMarket({ quoteAssetId: null, quoteMint: null }), SOL_QUOTE)
  assert.equal(quoteOfMarket({}), SOL_QUOTE)
  const stamped = { quoteAssetId: 'meta-xstock', quoteMint: META_MINT, quoteRegistryVersion: 1 }
  assert.equal(quoteOfMarket(stamped).symbol, 'METAx')
  assert.equal(quoteOfMarket(stamped, variant({ asset: { enabled: false } })).symbol, 'METAx')
  assert.equal(quoteAssetById('meta-xstock', variant({ asset: { enabled: false } })).enabled, false)
  assert.throws(() => quoteOfMarket({ ...stamped, quoteMint: TIP_TOKENS.find(t => t.symbol === 'MSFTx').mint }), code(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH))
  assert.throws(() => quoteOfMarket({ ...stamped, quoteAssetId: 'gone-xstock' }), code(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET))
  assert.throws(() => quoteOfMarket({ ...stamped, quoteAssetId: 'sol' }), code(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET))
})

test('the switch is exactly STOCK_QUOTES_ENABLED=true', () => {
  assert.equal(stockQuotesEnabled({ STOCK_QUOTES_ENABLED: 'true' }), true)
  for (const value of [undefined, 'false', 'TRUE', '1', 'yes', ' true']) assert.equal(stockQuotesEnabled({ STOCK_QUOTES_ENABLED: value }), false)
})
