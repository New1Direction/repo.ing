// Platform-fee sweep: claim every repo/phase, allocate under the active policy, move the partner
// wallet's surplus to the custody wallet, and report what to buy back. Dry run unless --execute.
//   node scripts/platform-sweep.mjs              print the plan, change nothing
//   node scripts/platform-sweep.mjs --execute    claim, allocate and transfer
// Wallets are constants (src/platform-sweep.mjs), never arguments. Exits non-zero on any error.
// Markets are read one at a time; an RPC rate limit (HTTP 429) or other transient error is retried with backoff, and a
// market still unreadable after its retries is reported with the retries spent. Progress goes to stderr, the report to stdout.
import { Connection, PublicKey } from '@solana/web3.js'
import { database, configAddress, partnerSigner } from '../app/lib/server.mjs'
import { platformTreasuryWallet } from '../src/platform-dbc-fees.mjs'
import { listPlatformFees, platformFeeService } from '../src/platform-fee-operations.mjs'
import { createPlatformRevenue, platformRevenueSummary } from '../src/platform-revenue.mjs'
import { runPlatformSweep, sweepHeadline } from '../src/platform-sweep.mjs'
import { createRpcMeter, registerRpcEndpoint } from '../src/rpc-usage.mjs'

const args = process.argv.slice(2)
const unknown = args.filter(arg => arg !== '--execute')
if (unknown.length) throw Error(`Unknown argument ${unknown[0]}. Usage: platform-sweep.mjs [--execute]`)
const execute = args.includes('--execute')
for (const name of ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'PLATFORM_PARTNER_SECRET_KEY']) {
  if (!process.env[name]) throw Error(`${name} required`)
}

// Both RPC providers go through one meter, as in the worker: a provider's HTTP 429 opens its backoff (honouring
// Retry-After) instead of web3.js's fixed retries, and the meter's lines go to stderr so stdout stays the report.
const meter = createRpcMeter({ log: line => console.error(line) })
const providerFetches = new Map()
const rpc = (url, commitment, provider) => {
  if (!providerFetches.has(url)) { providerFetches.set(url, meter.fetchFor(provider)); registerRpcEndpoint(url, providerFetches.get(url)) }
  return new Connection(url, { commitment, disableRetryOnRateLimit: true, fetch: providerFetches.get(url) })
}
const connection = rpc(process.env.SOLANA_RPC_URL, 'confirmed', 'primary')
const verification = process.env.GRADUATION_VERIFICATION_RPC_URL ? rpc(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized', 'verification') : null
const pool = database(), partner = partnerSigner(), config = configAddress()
const services = {}
const feeService = phase => (services[phase] ??= platformFeeService(phase, { pool, connection, config, partner, verification }))
const revenue = createPlatformRevenue({ pool, partnerWallet: platformTreasuryWallet(partner.publicKey) })
try {
  const report = await runPlatformSweep({ execute,
    dbcEnabled: process.env.PLATFORM_DBC_COLLECTION_ENABLED === 'true',
    listFees: options => listPlatformFees({ pool, feeService, ...options }),
    feeService, summary: () => platformRevenueSummary(pool), allocate: revenue.allocate,
    connection, signer: partner,
    balanceOf: address => connection.getBalance(new PublicKey(address), 'confirmed'),
    log: line => console.error(line) })
  console.log(JSON.stringify(report, null, 2))
  console.log(sweepHeadline(report))
  if (!report.ok) process.exitCode = 1
} finally {
  const usage = meter.flush()
  if (usage) console.error(JSON.stringify(usage))
  await pool.end()
}
