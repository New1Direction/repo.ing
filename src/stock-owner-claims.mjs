import { quoteAssetById } from './quote-assets.mjs'
import { STOCK_POLICY_ERRORS } from './stock-fee-policy.mjs'

// Stock-paired markets have no owner claim of builder fees (docs/STOCK_QUOTES.md, "Fee policy"; src/stock-fee-policy.mjs).
// The launcher earns 0.30% of every trade, paid in the stock, for as long as the market trades; the builder share and
// repo.ing's share go to that stock's accumulator, to become permanent $REPOING / <stock> liquidity. A company admin who
// verifies the repository changes nothing.
//
// Every owner-claim path refuses a stock-paired market with this code before any SOL claim code sees it: both claim routes
// (/api/claim, /api/builders/claim), the claim preview, the claim page, the builder dashboard (app/lib/builders.mjs) and
// builder reminders (src/builder-reminders.mjs leaves stock markets out of its list). The code is the policy module's.
export const STOCK_PAIR_NO_OWNER_CLAIM = STOCK_POLICY_ERRORS.STOCK_PAIR_NO_OWNER_CLAIM

// A market row from any read that carries migration 0053's stamp (camelCase or column names). SOL markets carry none.
export function isStockPairMarket(market) {
  return Boolean(market?.quoteAssetId ?? market?.quote_asset_id ?? market?.quoteMint ?? market?.quote_mint)
}

// The stock's symbol for copy, from the market's stamped asset id; never a guess from the mint.
export function stockSymbol(market) {
  const asset = quoteAssetById(market?.quoteAssetId ?? market?.quote_asset_id ?? null)
  return asset && asset.type === 'TOKENIZED_EQUITY' ? asset.symbol : 'the stock'
}

// Where a stock pair's fees go, in one sentence the refusal carries everywhere.
export function noOwnerClaimMessage(market = null) {
  const symbol = market ? stockSymbol(market) : 'the stock'
  const pair = symbol === 'the stock' ? '$REPOING / stock' : `$REPOING / ${symbol}`
  return `Stock-paired markets have no owner claim. 0.30% of every trade goes to the wallet that launched the market, paid in ${symbol}, ` +
    `and the builder share and repo.ing's share become permanent ${pair} liquidity. Verifying the repository does not change this.`
}

const REPO_ID = /^[1-9]\d{0,18}$/

// Of repoIds, those whose market is stock-paired: repoId (string) → its stamp { quoteAssetId, quoteMint }. A stamp is fixed
// once a launch is sent (migration 0053), so a market read here cannot turn into a SOL market before a claim reads it.
export async function stockPairStamps(db, repoIds) {
  const ids = [...new Set(repoIds.map(String))].filter(id => REPO_ID.test(id))
  if (!ids.length) return new Map()
  const { rows } = await db.query(`select github_repo_id::text as "repoId", quote_asset_id as "quoteAssetId", quote_mint as "quoteMint"
    from markets where github_repo_id = any($1::bigint[]) and (quote_asset_id is not null or quote_mint is not null)`, [ids])
  return new Map(rows.map(({ repoId, ...stamp }) => [repoId, stamp]))
}

// The stamp of one repository's market, or null for a SOL market and for a repository without one (the SOL claim path then
// refuses it exactly as before). A database error is thrown; the claim routes then fall through to the SOL claim path, which
// cannot resolve a stock pair's pool and refuses it.
export async function stockPairOf(db, repoId) {
  if (!REPO_ID.test(String(repoId ?? ''))) return null
  const { rows: [row] } = await db.query(`select quote_asset_id as "quoteAssetId", quote_mint as "quoteMint" from markets
    where github_repo_id = $1`, [String(repoId)])
  return isStockPairMarket(row) ? row : null
}
