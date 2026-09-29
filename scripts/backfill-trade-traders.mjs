// Fills wallet attribution (trader) and DAMM token amounts for trades indexed before migration 0026.
// Read-only RPC; writes only NULL columns, never inserts or deletes trades. Idempotent and resumable.
//   node scripts/backfill-trade-traders.mjs --dry-run            report what would be filled
//   node scripts/backfill-trade-traders.mjs                      apply
// Options: --batch 50 (signatures per commit), --delay-ms 250 (between RPC reads),
//   --after-dbc-id N / --after-damm-id N (resume past a row id), --max N (signatures this run).
import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { loadFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { backfillTraders, retrying, tradeParsers } from '../src/trader-backfill.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  if (at < 0) return fallback
  const value = Number(args[at + 1])
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`--${name} needs a non-negative integer`)
  return value
}
const dryRun = args.includes('--dry-run')
const batch = option('batch', 50), delayMs = option('delay-ms', 250), maxSignatures = option('max', Infinity)
if (batch < 1 || batch > 500) throw Error('--batch must be 1..500')
const { DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc, DBC_CONFIG: config } = process.env
if (!databaseUrl || !rpc || !config) throw Error('DATABASE_URL, SOLANA_RPC_URL and DBC_CONFIG are required')

const db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
const connection = new Connection(rpc, 'finalized')
const parse = tradeParsers({ dbc: new DynamicBondingCurveClient(connection, 'finalized'),
  resolveConfig: createMarketConfigResolver(config), dammCoder: new CpAmm(connection)._program.coder })
const log = entry => console.log(JSON.stringify(entry))
try {
  const totals = await backfillTraders({ db, parse, dryRun, batch, delayMs, maxSignatures, log,
    loadTransaction: retrying(signature => loadFinalizedTransaction(connection, signature)),
    afterId: { dbc: option('after-dbc-id', 0), damm: option('after-damm-id', 0) } })
  log({ done: true, dryRun, ...totals })
  if (totals.failed || totals.mismatched) process.exitCode = 1
} finally { await db.end() }
