import { Connection } from '@solana/web3.js'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { readGithubSession, githubSessionCookie } from '../../../lib/auth.mjs'
import { database, chain, configAddress } from '../../../lib/server.mjs'
import { QUOTE_REGISTRY } from '../../../../src/quote-assets.mjs'
import { quoteAssetInfo } from '../../../../src/quote-asset-info.mjs'
import { stockAccumulator, stockAsset } from '../../../../src/stock-accumulator.mjs'
import { createStockChainReader, createStockCollections } from '../../../../src/stock-collections.mjs'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

// Operator view of each stock's accumulator and every stock-paired market's collection preview (docs/STOCK_QUOTES.md,
// "Accumulator and settlement"). Read-only: there is no POST; nothing here signs, sends or writes, and no key is loaded.
// ?asset=<stock asset id> narrows it to one stock. Each stock carries its own { accumulator, collections } or error, so one
// failing read still returns 200.
export async function GET(request) {
  try { requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value)) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  const pool = database()
  if (!pool) return Response.json({ error: 'Database is not configured.' }, { status: 503, headers })
  const only = new URL(request.url).searchParams.get('asset')
  let assets
  try { assets = only ? [stockAsset(only)] : QUOTE_REGISTRY.assets }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 400, headers }) }
  // Without a usable RPC or config the ledgers still answer; the chain side reports why it is missing.
  let connection = null, collections = null, chainError = null
  try {
    connection = chain()
    const verification = process.env.GRADUATION_VERIFICATION_RPC_URL ? new Connection(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') : null
    collections = createStockCollections({ pool, reader: createStockChainReader({ connection, verification, config: configAddress() }) })
  } catch (error) { chainError = error.message }
  const stocks = []
  for (const asset of assets) {
    try {
      const previews = collections ? await collections.previewAll({ assetId: asset.assetId }) : []
      const onchain = collections ? new Map(previews.map(p => [p.repoId, p.uncollected === undefined ? { error: p.error ?? p.status } : { uncollected: p.uncollected }])) : null
      const info = connection ? await quoteAssetInfo(asset.assetId, { connection }).catch(() => null) : null
      const accumulator = await stockAccumulator(pool, asset.assetId, { onchain, units: { multiplier: info?.uiMultiplier ?? null, usdPrice: info?.usdPrice ?? null } })
      stocks.push({ assetId: asset.assetId, ok: true, accumulator, collections: previews, ...(chainError ? { chainError } : {}) })
    } catch (error) { stocks.push({ assetId: asset.assetId, ok: false, error: error.message }) }
  }
  return Response.json({ stocks, readOnly: true, checkedAt: new Date().toISOString() }, { headers })
}
