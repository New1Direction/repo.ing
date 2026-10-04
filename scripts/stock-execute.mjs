// Stock-pair fee collections into custody and launcher payouts (docs/STOCK_QUOTES.md, "Execution (off by default)").
// A DRY RUN unless --execute: it reads the pools, the stock ledgers and any pending rows and prints what it would collect, pay,
// settle, rebroadcast or abort, with each collection's terms hash. A dry run loads no key and signs, sends and writes nothing.
//   node scripts/stock-execute.mjs [--collections] [--payouts] [--asset <stock asset id>] [--repo <github repo id>] [--execute]
// Without --collections or --payouts it does both. --execute runs the same pass for real (as the worker job does), only for the
// kinds whose flag is set: STOCK_COLLECTIONS_EXECUTION_ENABLED=true and STOCK_LAUNCHER_PAYOUTS_ENABLED=true. Each transaction is
// recorded pending before it is sent and settled from its finalized receipt; keys are read only to sign (PLATFORM_CREATOR_SECRET_KEY
// for creator fees, PLATFORM_PARTNER_SECRET_KEY for partner fees and payouts from custody).
// Environment: DATABASE_URL, SOLANA_RPC_URL, DBC_CONFIG and STOCK_QUOTE_CONFIGS (as the worker has them); off localnet also
// GRADUATION_VERIFICATION_RPC_URL, a second RPC every deciding read must agree with. Exits non-zero on any ERROR or REVIEW.
import { listStockMarkets } from '../src/stock-collections.mjs'
import { createStockCollectionExecutor } from '../src/stock-collection-execution.mjs'
import { createStockLauncherPayouts } from '../src/stock-launcher-payouts.mjs'
import { STOCK_EXECUTION_FLAGS, stockExecutionFlags } from '../src/stock-execution.mjs'
import { describeStockExecution, runStockExecution, stockExecutionLoud } from '../src/stock-execution-job.mjs'
import { asset, cli, run } from './stock-cli.mjs'

const USAGE = 'Usage: node scripts/stock-execute.mjs [--collections] [--payouts] [--asset <stock asset id>] [--repo <github repo id>] [--execute]'
const args = cli(USAGE, { collections: { type: 'boolean' }, payouts: { type: 'boolean' }, asset: { type: 'string' }, repo: { type: 'string' },
  execute: { type: 'boolean' } })
if (args.repo !== undefined && !/^[1-9]\d{0,18}$/.test(args.repo)) { console.error(`--repo must be a GitHub repository id\n${USAGE}`); process.exit(2) }
const assetId = args.asset === undefined ? null : asset(args.asset, USAGE).assetId
const kinds = { collections: Boolean(args.collections || !args.payouts), payouts: Boolean(args.payouts || !args.collections) }
const execute = Boolean(args.execute)
if (execute) {
  const flags = stockExecutionFlags()
  const off = Object.keys(kinds).filter(kind => kinds[kind] && !flags[kind]).map(kind => `${STOCK_EXECUTION_FLAGS[kind]}=true`)
  if (off.length) { console.error(`--execute needs ${off.join(' and ')}; nothing was read, signed or sent.`); process.exit(2) }
}

await run(async ({ pool, connection, verification }) => {
  if (!process.env.DBC_CONFIG) throw Error('DBC_CONFIG required')
  const collections = kinds.collections ? createStockCollectionExecutor({ pool, connection, verification, config: process.env.DBC_CONFIG }) : null
  const payouts = kinds.payouts ? createStockLauncherPayouts({ pool, connection, verification }) : null
  const report = await runStockExecution({ collections, payouts, listMarkets: filter => listStockMarkets(pool, filter), execute, assetId,
    repoId: args.repo ?? null, verbose: true })
  if (stockExecutionLoud(report)) process.exitCode = 1
  return { json: { mode: execute ? 'execute' : 'dry-run', ...report }, lines: describeStockExecution(report, { execute }) }
})
