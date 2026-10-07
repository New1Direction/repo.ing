// Prints the contributor early access go-live checklist (docs/EARLY_ACCESS.md, step 8): PASS / FAIL / TODO with a one-line reason
// each, then the switches ON or OFF. Exits 1 if anything FAILs. READ-ONLY: it reads mainnet accounts and, with DATABASE_URL, a few
// catalog SELECTs in a READ ONLY transaction that is rolled back. It loads no key (the oracle is given by its public key) and
// signs, sends and writes nothing. The checks are src/early-access-readiness.mjs.
//   node scripts/early-access-readiness.mjs --oracle <public key>
//   railway ssh --service web -- node scripts/early-access-readiness.mjs --oracle <public key>   (with that service's settings)
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { Connection, PublicKey } from '@solana/web3.js'
import { COMMITMENT, READINESS_ENV, checkEarlyAccessReadiness, formatReadiness } from '../src/early-access-readiness.mjs'

export const USAGE = `Usage: node scripts/early-access-readiness.mjs [--oracle <public key>]   (reads only; never signs, sends or writes)
It reads only these variables, and never prints the RPC or database URL:
  SOLANA_RPC_URL                                      a mainnet RPC (required)
  DATABASE_URL                                        optional: adds the database check
  EARLY_ACCESS_DBC_CONFIG, EARLY_ACCESS_LOOKUP_TABLE  the config and lookup table to check
  BUILDER_ALLOCATION_CONFIGS                          whether it lists the config
  EARLY_ACCESS_ENABLED                                shown as on or off
`

// Only the variables the checks use are taken from the environment: nothing else, secrets included, is ever read.
export function readinessEnv(source = process.env) {
  return Object.fromEntries(READINESS_ENV.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) return void process.stdout.write(USAGE)
  const env = readinessEnv()
  const at = args.indexOf('--oracle')
  let oracle = null
  try { oracle = at >= 0 ? new PublicKey(args[at + 1]) : null } catch { oracle = undefined }
  const unknown = args.find((arg, index) => !(arg === '--oracle' || index === at + 1 && at >= 0))
  if (unknown || oracle === undefined || !env.SOLANA_RPC_URL?.trim()) {
    process.stderr.write(`${unknown ? `Unknown argument: ${unknown}` : oracle === undefined ? '--oracle must be a base58 public key' : 'SOLANA_RPC_URL is required'}\n${USAGE}`)
    process.exitCode = 1
    return
  }
  const connection = new Connection(env.SOLANA_RPC_URL.trim(), COMMITMENT)
  let db = null, dbError = null
  if (env.DATABASE_URL?.trim()) {
    const client = new pg.Client({ connectionString: env.DATABASE_URL.trim(), application_name: 'repoing-early-access-readiness' })
    try { await client.connect(); db = client } catch (error) { dbError = error }
  }
  try {
    const report = await checkEarlyAccessReadiness({ env, connection, db, dbError, oracle })
    process.stdout.write(`${formatReadiness(report)}\n`)
    if (!report.ok) process.exitCode = 1
  } finally { await db?.end().catch(() => {}) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    const secrets = [process.env.SOLANA_RPC_URL, process.env.DATABASE_URL].map(value => value?.trim()).filter(Boolean)
    const message = secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(error?.message ?? error)).slice(0, 300)
    process.stderr.write(`early access readiness could not run: ${message}\n`)
    process.exitCode = 1
  })
}
