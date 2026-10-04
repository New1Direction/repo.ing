// Stock-pair fee collections into custody and launcher payouts (docs/STOCK_QUOTES.md, "Execution (off by default)"). Run it on
// the owner's machine, never on the worker or web service: like scripts/platform-sweep.mjs it is the only place these
// transactions are signed, and its keys come from the macOS Keychain (src/stock-keychain.mjs), never from the environment.
// A DRY RUN unless --execute: it reads the pools, the stock ledgers and any pending rows and prints what it would collect, pay,
// settle, rebroadcast or abort, with each collection's terms hash. A dry run loads no key and signs, sends and writes nothing.
//   node scripts/stock-execute.mjs [--collections] [--payouts] [--damm] [--asset <stock asset id>] [--repo <github repo id>] [--execute]
// Without --collections or --payouts it does both. Graduated-pool (DAMM) collections run only with --damm, until a validator test
// covers them. --execute runs the same pass for real, only for the kinds whose flag is set (STOCK_COLLECTIONS_EXECUTION_ENABLED=true,
// STOCK_LAUNCHER_PAYOUTS_ENABLED=true), reading each key from the Keychain only to sign: repo.ing.dbc.creator for creator fees,
// repo.ing.dbc.partner (which must be the custody wallet) for partner fees and payouts. Each transaction is recorded pending
// before it is sent and settled from its finalized receipt; the worker finishes any it leaves pending, without a key.
// Environment: DATABASE_URL, SOLANA_RPC_URL, DBC_CONFIG and STOCK_QUOTE_CONFIGS (as the worker has them); off localnet also
// GRADUATION_VERIFICATION_RPC_URL, a second RPC the previews and recovery's abort decisions must agree with. Exits non-zero on
// any ERROR or REVIEW.
import { STOCK_COLLECTION_SOURCES, STOCK_FEE_CUSTODY, listStockMarkets } from '../src/stock-collections.mjs'
import { STOCK_DEFAULT_COLLECTION_SOURCES, createStockCollectionExecutor } from '../src/stock-collection-execution.mjs'
import { createStockLauncherPayouts } from '../src/stock-launcher-payouts.mjs'
import { STOCK_EXECUTION_FLAGS, stockExecutionFlags } from '../src/stock-execution.mjs'
import { describeStockExecution, runStockExecution, stockExecutionLoud } from '../src/stock-execution-job.mjs'
import { keychainSigners } from '../src/stock-keychain.mjs'
import { asset, cli, run } from './stock-cli.mjs'

const USAGE = 'Usage: node scripts/stock-execute.mjs [--collections] [--payouts] [--damm] [--asset <stock asset id>] [--repo <github repo id>] [--execute]'
const args = cli(USAGE, { collections: { type: 'boolean' }, payouts: { type: 'boolean' }, damm: { type: 'boolean' }, asset: { type: 'string' },
  repo: { type: 'string' }, execute: { type: 'boolean' } })
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
  // Keys only for --execute, each read from the Keychain the first time a transaction needs it.
  const loadSigner = execute ? keychainSigners({ expected: { partner: STOCK_FEE_CUSTODY } }) : null
  const collections = kinds.collections ? createStockCollectionExecutor({ pool, connection, verification, config: process.env.DBC_CONFIG,
    loadSigner, sources: args.damm ? STOCK_COLLECTION_SOURCES : STOCK_DEFAULT_COLLECTION_SOURCES }) : null
  const payouts = kinds.payouts ? createStockLauncherPayouts({ pool, connection, verification, loadSigner }) : null
  const report = await runStockExecution({ collections, payouts, listMarkets: filter => listStockMarkets(pool, filter), execute, assetId,
    repoId: args.repo ?? null, verbose: true })
  if (stockExecutionLoud(report)) process.exitCode = 1
  return { json: { mode: execute ? 'execute' : 'dry-run', ...report }, lines: describeStockExecution(report, { execute }) }
})
