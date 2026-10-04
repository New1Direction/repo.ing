import { parseArgs } from 'node:util'
import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { quoteAssetInfo } from '../src/quote-asset-info.mjs'
import { stockAsset } from '../src/stock-accumulator.mjs'

// Shared by the stock accumulator scripts (scripts/stock-*.mjs): strict arguments, the database and read-only RPC
// connections, and display units. None of them loads a key, signs or sends anything; --write (where offered) writes to the
// database only. Not a script itself.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

export function cli(usage, options) {
  let parsed
  try { parsed = parseArgs({ args: process.argv.slice(2), options: { ...options, help: { type: 'boolean' } }, strict: true, allowPositionals: false }) }
  catch (error) { console.error(`${error.message}\n${usage}`); process.exit(2) }
  if (parsed.values.help) { console.log(usage); process.exit(0) }
  return parsed.values
}

export function asset(id, usage) {
  try { return stockAsset(id) } catch { console.error(`--asset must be a stock asset id from src/quote-assets.mjs\n${usage}`); process.exit(2) }
}

// The database and RPCs come from the environment only: DATABASE_URL, SOLANA_RPC_URL and, when set, a second RPC
// (GRADUATION_VERIFICATION_RPC_URL) that every chain read must agree with.
async function connections() {
  for (const name of ['DATABASE_URL', 'SOLANA_RPC_URL']) if (!process.env[name]) throw Error(`${name} required`)
  const connection = new Connection(process.env.SOLANA_RPC_URL, 'finalized')
  const verification = process.env.GRADUATION_VERIFICATION_RPC_URL ? new Connection(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') : null
  const genesis = await connection.getGenesisHash()
  if (verification && await verification.getGenesisHash() !== genesis) throw Error('The two RPCs are on different networks')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return { pool, connection, verification, network: genesis === MAINNET_GENESIS ? 'mainnet' : `genesis ${genesis}` }
}

// --write records mainnet facts only, read through two RPCs that agree (GRADUATION_VERIFICATION_RPC_URL), as SOL fee collection
// requires before anything is recorded.
export function assertWritable({ network, verification }) {
  if (network !== 'mainnet') throw Error(`--write records mainnet transactions only; this RPC is on ${network}`)
  if (!verification) throw Error('--write needs a second RPC (GRADUATION_VERIFICATION_RPC_URL) that agrees with every read')
}

// The stock's display units (multiplier and USD price); a failed read only drops the labels, never the raw amounts.
export async function units(connection, assetId) {
  try {
    const info = await quoteAssetInfo(assetId, { connection })
    return { multiplier: info?.uiMultiplier ?? null, usdPrice: info?.usdPrice ?? null }
  } catch { return {} }
}

// Runs work(context) and prints its JSON report, then its plain-English lines. Any error stops the script non-zero.
export async function run(work) {
  let context
  try {
    context = await connections()
    const { json, lines } = await work(context)
    console.log(JSON.stringify({ network: context.network, ...json }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2))
    console.log(lines.join('\n'))
  } catch (error) {
    console.error(`STOPPED: ${error.message}`)
    process.exitCode = 1
  } finally { await context?.pool.end() }
}
