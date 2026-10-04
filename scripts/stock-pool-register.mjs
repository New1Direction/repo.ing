// Registers a stock's canonical REPOING/<stock> DAMM v2 pool (docs/STOCK_QUOTES.md, "Accumulator and settlement"). The owner
// creates and seeds the pool himself; this script only checks it against the chain: a DAMM v2 pool of exactly REPOING and the
// stock's pinned mint, with the program's own vaults, whose creation transaction an owner wallet signed, paid for and seeded,
// and the owner's position in it. DRY RUN BY DEFAULT: it prints what it found and what it would record. --write records it in
// stock_canonical_pools (the database only, one active pool per stock), on mainnet only and with a second RPC
// (GRADUATION_VERIFICATION_RPC_URL) agreeing. It loads no key and signs or sends nothing.
//   node scripts/stock-pool-register.mjs --asset meta-xstock --pool <pool> --creation <creation signature> [--position <position>] [--write]
// Without --position, the one position an owner wallet holds in the pool is used. Environment: DATABASE_URL, SOLANA_RPC_URL.
import { PublicKey } from '@solana/web3.js'
import { activeCanonicalPool, describeCanonicalPool, registerCanonicalPool, verifyCanonicalPool } from '../src/stock-canonical-pools.mjs'
import { assertWritable, asset, cli, run } from './stock-cli.mjs'

const USAGE = 'Usage: node scripts/stock-pool-register.mjs --asset <stock asset id> --pool <address> --creation <signature> [--position <address>] [--write]'
const args = cli(USAGE, { asset: { type: 'string' }, pool: { type: 'string' }, creation: { type: 'string' }, position: { type: 'string' },
  write: { type: 'boolean' } })
const stock = asset(args.asset, USAGE)
if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(args.creation ?? '')) { console.error(`--creation must be the pool's creation transaction signature\n${USAGE}`); process.exit(2) }
for (const name of ['pool', ...(args.position ? ['position'] : [])]) {
  try { new PublicKey(args[name]) } catch { console.error(`--${name} must be a Solana address\n${USAGE}`); process.exit(2) }
}

await run(async ({ pool, connection, verification, network }) => {
  if (args.write) assertWritable({ network, verification })
  const verified = await verifyCanonicalPool({ connection, verification, assetId: stock.assetId, pool: args.pool, position: args.position ?? null,
    creationSignature: args.creation })
  const lines = describeCanonicalPool(verified)
  const active = await activeCanonicalPool(pool, stock.assetId)
  if (!args.write) {
    lines.push(active?.pool === verified.pool ? 'It is already the active canonical pool: nothing to write.'
      : active ? `${active.pool} is already the active canonical REPOING/${stock.symbol} pool: --write would be refused (retiring it is an owner decision).`
        : `Dry run: nothing written. With --write it becomes the active canonical REPOING/${stock.symbol} pool.`)
    return { json: { verified, active, written: false }, lines }
  }
  const result = await registerCanonicalPool(pool, verified)
  lines.push(result.status === 'registered' ? `Recorded as the active canonical REPOING/${stock.symbol} pool (stock_canonical_pools row ${result.row.id}).`
    : 'It was already the active canonical pool: nothing changed.')
  return { json: { verified, result, written: result.status === 'registered' }, lines }
})
