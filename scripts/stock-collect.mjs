// Preview of collecting stock-paired markets' fees into custody (docs/STOCK_QUOTES.md, "Accumulator and settlement").
// READ-ONLY: for every stock-paired market (or one stock, or one market) it reads what the Meteora pools hold and what the
// stock ledgers expect and, only where they agree exactly, prints the exact instructions and amounts a collection WOULD use
// with the hash of its terms, beside each stock's accumulator. It loads no key and signs, sends and writes nothing:
// collection execution comes later, behind an operator flag.
//   node scripts/stock-collect.mjs [--asset meta-xstock] [--repo <github repo id>]
// Environment: DATABASE_URL, SOLANA_RPC_URL, DBC_CONFIG and STOCK_QUOTE_CONFIGS (as the worker has them). Off localnet a second
// RPC, GRADUATION_VERIFICATION_RPC_URL, must agree with every read before a collection is planned, as for SOL platform fees.
import { QUOTE_REGISTRY } from '../src/quote-assets.mjs'
import { describeAccumulator, stockAccumulator } from '../src/stock-accumulator.mjs'
import { createStockChainReader, createStockCollections, custodyStockBalance, describeCollectionPreview } from '../src/stock-collections.mjs'
import { asset, cli, run, units } from './stock-cli.mjs'

const USAGE = 'Usage: node scripts/stock-collect.mjs [--asset <stock asset id>] [--repo <github repo id>]'
const args = cli(USAGE, { asset: { type: 'string' }, repo: { type: 'string' }, write: { type: 'boolean' } })
if (args.write) { console.error('stock-collect only previews: it never writes. Collection execution is not built yet.'); process.exit(2) }
if (args.repo !== undefined && !/^[1-9]\d{0,18}$/.test(args.repo)) { console.error(`--repo must be a GitHub repository id\n${USAGE}`); process.exit(2) }
const assets = args.asset ? [asset(args.asset, USAGE)] : QUOTE_REGISTRY.assets

await run(async ({ pool, connection, verification }) => {
  if (!process.env.DBC_CONFIG) throw Error('DBC_CONFIG required')
  const collections = createStockCollections({ pool,
    reader: createStockChainReader({ connection, verification, config: process.env.DBC_CONFIG }) })
  const json = { assets: [] }, lines = []
  for (const stock of assets) {
    const previews = await collections.previewAll({ assetId: stock.assetId, repoId: args.repo ?? null })
    const onchain = new Map(previews.map(p => [p.repoId, p.uncollected === undefined ? { error: p.error ?? p.status } : { uncollected: p.uncollected }]))
    const accumulator = await stockAccumulator(pool, stock.assetId, { onchain, units: await units(connection, stock.assetId),
      custodyBalance: await custodyStockBalance(connection, stock) })
    json.assets.push({ assetId: stock.assetId, accumulator, collections: previews })
    lines.push(...describeAccumulator(accumulator))
    if (!previews.length) lines.push(`  No launched ${stock.symbol} market is indexed${args.repo ? ` as repository ${args.repo}` : ''}: nothing to collect.`)
    for (const preview of previews) lines.push(...describeCollectionPreview(preview, stock).map(line => `  ${line}`))
  }
  lines.push('Nothing was signed, sent or written.')
  return { json, lines }
})
