// Prints the stock-pair go-live checklist (docs/STOCK_GO_LIVE.md, step 5): PASS / FAIL / TODO with a one-line reason each, then
// the switches ON or OFF. Exits 1 if anything FAILs. READ-ONLY: it reads mainnet accounts and, with DATABASE_URL, runs SELECTs in
// READ ONLY transactions that are rolled back. It loads no key and signs, sends and writes nothing. The checks are
// src/stock-readiness.mjs.
//   node scripts/stock-readiness.mjs
//   railway ssh --service web -- node scripts/stock-readiness.mjs      (with that service's own settings)
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { COMMITMENT, READINESS_ENV, checkStockReadiness, formatReadiness } from '../src/stock-readiness.mjs'

export const USAGE = `Usage: node scripts/stock-readiness.mjs   (reads only; never signs, sends or writes)
It reads only these variables, and never prints the RPC or database URL:
  SOLANA_RPC_URL                       a mainnet RPC (required)
  DATABASE_URL                         optional: adds the database checks
  STOCK_QUOTE_CONFIGS, DBC_CONFIG      the stock configs to check, and the SOL launch config they must match
  STOCK_QUOTES_ENABLED, STOCK_COLLECTIONS_EXECUTION_ENABLED, STOCK_LAUNCHER_PAYOUTS_ENABLED   shown as on or off
`

// Only the variables the checks use are taken from the environment: nothing else, secrets included, is ever read.
export function readinessEnv(source = process.env) {
  return Object.fromEntries(READINESS_ENV.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) return void process.stdout.write(USAGE)
  const env = readinessEnv()
  if (args.length || !env.SOLANA_RPC_URL?.trim()) {
    process.stderr.write(`${args.length ? `Unknown argument: ${args[0]}` : 'SOLANA_RPC_URL is required'}\n${USAGE}`)
    process.exitCode = 1
    return
  }
  const connection = new Connection(env.SOLANA_RPC_URL.trim(), COMMITMENT)
  let db = null, dbError = null
  if (env.DATABASE_URL?.trim()) {
    const client = new pg.Client({ connectionString: env.DATABASE_URL.trim(), application_name: 'repoing-stock-readiness' })
    try { await client.connect(); db = client } catch (error) { dbError = error }
  }
  try {
    const report = await checkStockReadiness({ env, connection, db, dbError })
    process.stdout.write(formatReadiness(report))
    process.exitCode = report.ok ? 0 : 1
  } finally { await db?.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    const secrets = [process.env.SOLANA_RPC_URL, process.env.DATABASE_URL].map(value => value?.trim()).filter(Boolean)
    const message = secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(error?.message ?? error)).slice(0, 300)
    process.stderr.write(`stock readiness could not run: ${message}\n`)
    process.exitCode = 1
  })
}
