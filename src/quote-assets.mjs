import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { isGithubRepoId } from './market-identity.mjs'

// Quote assets a market can be paired with (docs/STOCK_QUOTES.md). SOL is the default and the quote of every market launched
// before stock pairs; it is never stamped on a market (markets.quote_* stay null, migration 0053).
//
// A tokenized stock is offered only through this explicit, versioned registry, never inferred:
//   GitHub organization → public company → tokenized stock → pinned Solana mint.
// Companies are keyed on GitHub's numeric owner id, not the login: a login can be renamed and later registered by someone
// else, and only verified organizations are listed. Assets are separate from companies so the provider is a property of the
// asset, never of the market model.
//
// Changing the registry: append, never edit. An asset id's mint never changes (historical markets resolve through their
// stamped asset id and must keep the same mint); a provider migration is a new asset id. Disabling an asset or company
// stops new launches only. Bump QUOTE_REGISTRY_VERSION with any change, so a market's stamp records which registry chose it.
export const QUOTE_REGISTRY_VERSION = 1

// Stable error codes for every refusal (the launch API returns them as `code`). Nothing ever falls back from a stock to SOL.
export const QUOTE_ERRORS = Object.freeze({
  COMPANY_MAPPING_NOT_FOUND: 'COMPANY_MAPPING_NOT_FOUND',
  STOCK_ASSET_NOT_FOUND: 'STOCK_ASSET_NOT_FOUND',
  STOCK_ASSET_DISABLED: 'STOCK_ASSET_DISABLED',
  QUOTE_ASSET_INVALID: 'QUOTE_ASSET_INVALID',
  QUOTE_ASSET_MISMATCH: 'QUOTE_ASSET_MISMATCH',
  UNSUPPORTED_QUOTE_ASSET: 'UNSUPPORTED_QUOTE_ASSET',
})

export class QuoteAssetError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.status = 400
  }
}

const SPL = TOKEN_PROGRAM_ID.toBase58()
const T22 = TOKEN_2022_PROGRAM_ID.toBase58()
const ASSET_ID = /^[a-z0-9][a-z0-9-]{1,31}$/

export const SOL_QUOTE = Object.freeze({ type: 'SOL', assetId: 'sol', symbol: 'SOL', name: 'Solana', mint: NATIVE_MINT.toBase58(),
  decimals: 9, tokenProgram: SPL })

// GitHub owner ids from GitHub's organizations API (GET /orgs/<login>: type Organization, is_verified true), read 2026-10-03.
const COMPANIES = [
  { githubOwnerId: '69631', githubOrg: 'facebook', companyId: 'meta-platforms', companyName: 'Meta Platforms', ticker: 'META', enabled: true },
  { githubOwnerId: '6154722', githubOrg: 'microsoft', companyId: 'microsoft', companyName: 'Microsoft', ticker: 'MSFT', enabled: true },
  { githubOwnerId: '1728152', githubOrg: 'nvidia', companyId: 'nvidia', companyName: 'NVIDIA', ticker: 'NVDA', enabled: true },
]

// Backed Finance xStocks: mints from the issuer's Assets API (https://api.xstocks.fi/api/v2/public/assets/<symbol>,
// deployment network "Solana"), checked on mainnet 2026-10-03: Token-2022, 8 decimals. The same mints are on the tip
// allowlist (src/tip-tokens.mjs; tests/quote-assets.test.mjs keeps the two in agreement). The issuer can pause, freeze,
// move (permanent delegate) and rescale (ScaledUiAmount) these tokens; docs/STOCK_QUOTES.md lists what that means here.
const xStock = (assetId, companyId, ticker, symbol, name, mint) => ({ type: 'TOKENIZED_EQUITY', assetId, companyId, ticker, symbol,
  name, mint, decimals: 8, tokenProgram: T22, provider: 'backed-xstocks', chain: 'solana', enabled: true })
const ASSETS = [
  xStock('meta-xstock', 'meta-platforms', 'META', 'METAx', 'Meta xStock', 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'),
  xStock('msft-xstock', 'microsoft', 'MSFT', 'MSFTx', 'Microsoft xStock', 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX'),
  xStock('nvda-xstock', 'nvidia', 'NVDA', 'NVDAx', 'NVIDIA xStock', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'),
]

export const QUOTE_REGISTRY = Object.freeze({ version: QUOTE_REGISTRY_VERSION,
  companies: Object.freeze(COMPANIES.map(Object.freeze)), assets: Object.freeze(ASSETS.map(Object.freeze)) })

// Off unless exactly "true": the quote-options API then offers SOL only and a launch accepts SOL only.
export const stockQuotesEnabled = (env = process.env) => env.STOCK_QUOTES_ENABLED === 'true'

// The listed company a repository owner is: a GitHub organization, matched by numeric id only.
export function companyForOwner({ ownerId, ownerType } = {}, registry = QUOTE_REGISTRY) {
  if (ownerType !== 'Organization' || !/^[1-9]\d{0,18}$/.test(String(ownerId ?? ''))) return null
  return registry.companies.find(company => company.githubOwnerId === String(ownerId)) ?? null
}

// A quote asset by id, disabled ones included (a historical market keeps resolving), or null.
export function quoteAssetById(assetId, registry = QUOTE_REGISTRY) {
  if (assetId === SOL_QUOTE.assetId) return SOL_QUOTE
  return registry.assets.find(asset => asset.assetId === assetId) ?? null
}

const solOption = Object.freeze({ type: 'SOL', assetId: SOL_QUOTE.assetId, symbol: SOL_QUOTE.symbol, eligible: true })

// The pairs a repository can launch with. repo: { repoId, ownerId, ownerType } as GitHub reported them just now; without a
// confirmed owner id only SOL is offered. Every asset of the owner's company is listed, enabled ones first (at most one is
// enabled per company, tests/quote-assets.test.mjs); a disabled one is marked not eligible, with its code, so a replaced
// asset stays visible while its successor is offered.
export function quoteOptions(repo, { enabled = false, registry = QUOTE_REGISTRY } = {}) {
  if (!enabled || !repo || !isGithubRepoId(repo.repoId)) return [solOption]
  const company = companyForOwner(repo, registry)
  if (!company?.enabled) return [solOption]
  const assets = registry.assets.filter(candidate => candidate.companyId === company.companyId)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
  return [solOption, ...assets.map(asset => ({ type: asset.type, assetId: asset.assetId, symbol: asset.symbol, ticker: company.ticker,
    company: company.companyName, githubOrg: company.githubOrg, provider: asset.provider, eligible: asset.enabled,
    ...asset.enabled ? {} : { reason: QUOTE_ERRORS.STOCK_ASSET_DISABLED } }))]
}

// A launch's quoteAssetId (the only quote input a client ever sends) → the full asset, with eligibility re-derived from the
// repository owner GitHub just reported. Absent or "sol" is SOL. Everything else must be an enabled registry asset of the
// company that owns the repository; otherwise a QuoteAssetError with a stable code. Tickers, mints and company names are not
// accepted as ids.
export function resolveQuoteAsset(quoteAssetId, repo, { enabled = false, registry = QUOTE_REGISTRY } = {}) {
  if (quoteAssetId === undefined || quoteAssetId === null || quoteAssetId === SOL_QUOTE.assetId) return SOL_QUOTE
  if (typeof quoteAssetId !== 'string' || !ASSET_ID.test(quoteAssetId)) {
    throw new QuoteAssetError(QUOTE_ERRORS.QUOTE_ASSET_INVALID, 'Choose SOL or one of the stock pairs offered for this repository.')
  }
  if (!enabled) throw new QuoteAssetError(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available.')
  const asset = registry.assets.find(candidate => candidate.assetId === quoteAssetId)
  if (!asset) throw new QuoteAssetError(QUOTE_ERRORS.STOCK_ASSET_NOT_FOUND, 'That stock pair is not supported.')
  if (!asset.enabled) throw new QuoteAssetError(QUOTE_ERRORS.STOCK_ASSET_DISABLED, `${asset.symbol} pairs are paused for new launches.`)
  if (!repo || !isGithubRepoId(repo.repoId)) throw new QuoteAssetError(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are available for GitHub repositories only.')
  const company = companyForOwner(repo, registry)
  if (!company?.enabled) throw new QuoteAssetError(QUOTE_ERRORS.COMPANY_MAPPING_NOT_FOUND, 'This repository is not owned by a supported company.')
  if (company.companyId !== asset.companyId) {
    throw new QuoteAssetError(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH, `${asset.symbol} is not offered for repositories owned by ${company.githubOrg}.`)
  }
  return Object.freeze({ ...asset, companyName: company.companyName, githubOrg: company.githubOrg, registryVersion: registry.version })
}

// The quote a market row trades in: SOL when unstamped, else its stamped asset, which must still name the stamped mint.
export function quoteOfMarket(market, registry = QUOTE_REGISTRY) {
  if (!market?.quoteAssetId && !market?.quoteMint) return SOL_QUOTE
  const asset = quoteAssetById(market.quoteAssetId, registry)
  if (!asset || asset === SOL_QUOTE) throw new QuoteAssetError(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Market quote asset is not in the registry')
  if (asset.mint !== market.quoteMint) throw new QuoteAssetError(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH, 'Market quote mint differs from its registry asset')
  return asset
}

// The columns a reservation stamps for a resolved quote (all null for SOL, migration 0053).
export function quoteStamp(quote) {
  if (!quote || quote.type === 'SOL') return { quoteAssetId: null, quoteMint: null, quoteRegistryVersion: null }
  return { quoteAssetId: quote.assetId, quoteMint: quote.mint, quoteRegistryVersion: quote.registryVersion }
}
