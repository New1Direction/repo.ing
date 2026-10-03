import { isGithubRepoId } from '../../src/market-identity.mjs'
import { QUOTE_ERRORS, QuoteAssetError, SOL_QUOTE, quoteOfMarket, resolveQuoteAsset, stockPairsLaunchable } from '../../src/quote-assets.mjs'
import { stockConfigFor } from '../../src/quote-configs.mjs'
import { resolveRepositoryOwner } from '../../src/github.mjs'
import { checkTipMint } from '../../src/tip-tokens.mjs'

// The pair a launch asks for (docs/STOCK_QUOTES.md), decided before anything is read for the launch or reserved, and the guard
// that decides it again after reservation and after the wallet signed. Every refusal is a QuoteAssetError with its code; nothing
// falls back from a stock pair to SOL.
const isSol = quoteAssetId => quoteAssetId === undefined || quoteAssetId === null || quoteAssetId === SOL_QUOTE.assetId
const refuse = (code, message) => new QuoteAssetError(code, message)

// The stock's mint as it is on chain now must still move like the asset was approved: no pause, no active transfer hook or fee,
// accounts not frozen by default, the same program and decimals (the tip allowlist's check, src/tip-tokens.mjs).
export function stockMintCheck(connection) {
  return async quote => {
    try { await checkTipMint(connection, { mint: quote.mint, program: quote.tokenProgram, decimals: quote.decimals }, 'confirmed') }
    catch (error) { throw refuse(QUOTE_ERRORS.STOCK_ASSET_DISABLED, `${quote.symbol} cannot be paired right now: ${error.message}`) }
  }
}

// { quote, config } for a launch request body. SOL takes the configured SOL config, exactly as before. A stock pair needs stock
// launches to be ready, a GitHub repository launched from its launch page (no trend or agent-draft shortcut), the stock of the
// company that owns the repository on GitHub right now, that stock's own config, and its mint usable now.
export async function launchPair(body, { solConfig, enabled = stockPairsLaunchable(), owner = resolveRepositoryOwner,
  configFor = stockConfigFor, mintUsable }) {
  if (isSol(body.quoteAssetId)) return { quote: SOL_QUOTE, config: solConfig }
  if (!enabled) {
    resolveQuoteAsset(body.quoteAssetId, null, { enabled: false })
    throw refuse(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are not available.')
  }
  if (!isGithubRepoId(body.repoId)) throw refuse(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are available for GitHub repositories only.')
  if (body.trendRevision !== undefined || body.agentDraft !== undefined) {
    throw refuse(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, 'Stock pairs are launched from the launch page only.')
  }
  const repoId = String(body.repoId)
  const quote = resolveQuoteAsset(body.quoteAssetId, { repoId, ...await owner(repoId) }, { enabled })
  const config = configFor(quote.assetId)
  if (!config) throw refuse(QUOTE_ERRORS.UNSUPPORTED_QUOTE_ASSET, `${quote.symbol} pairs are not open for launches yet.`)
  await mintUsable(quote)
  return { quote, config: config.toBase58() }
}

// launchGuard for a stock-paired launch: at prepare (after reservation) and at submit (after the wallet signed), the pair must
// still be launchable, the repository still owned by that company, the config unchanged, and the mint still usable.
export function stockPairGuard(quote, config, { enabled = stockPairsLaunchable, owner = resolveRepositoryOwner, configFor = stockConfigFor,
  mintUsable }) {
  return async ({ repo }) => {
    const repoId = String(repo.githubRepoId)
    const again = resolveQuoteAsset(quote.assetId, { repoId, ...await owner(repoId) }, { enabled: enabled() })
    if (again.mint !== quote.mint) throw refuse(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH, 'This stock pair changed. Review the launch again.')
    if (configFor(quote.assetId)?.toBase58() !== config) throw refuse(QUOTE_ERRORS.QUOTE_ASSET_MISMATCH, 'This stock pair changed. Review the launch again.')
    await mintUsable(quote)
  }
}

// The guard for a launch decided by its reservation's stamp (src/quote-assets.mjs): a stock-paired market is decided again as at
// prepare; a SOL market needs nothing more. Used after the wallet signed, when only the stamp says which pair it is.
export function marketPairGuard(config, deps) {
  return async context => {
    const quote = quoteOfMarket(context.market)
    if (quote.type === 'SOL') return
    await stockPairGuard(quote, config, deps)(context)
  }
}

// Several launch guards in order; each must pass.
export const composeGuards = (...guards) => async context => { for (const guard of guards.filter(Boolean)) await guard(context) }
