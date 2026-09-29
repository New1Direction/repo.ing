// Platform-fee sweep: claim every repo/phase, allocate under the active policy, move the partner
// wallet's surplus to the custody wallet, and report what to buy back. Dry run unless --execute.
//   node scripts/platform-sweep.mjs              print the plan, change nothing
//   node scripts/platform-sweep.mjs --execute    claim, allocate and transfer
// Wallets are constants (src/platform-sweep.mjs), never arguments. Exits non-zero on any error.
import { PublicKey } from '@solana/web3.js'
import { database, chain, configAddress, partnerSigner } from '../app/lib/server.mjs'
import { platformTreasuryWallet } from '../src/platform-dbc-fees.mjs'
import { listPlatformFees, platformFeeService } from '../src/platform-fee-operations.mjs'
import { createPlatformRevenue, platformRevenueSummary } from '../src/platform-revenue.mjs'
import { runPlatformSweep, sweepHeadline } from '../src/platform-sweep.mjs'

const args = process.argv.slice(2)
const unknown = args.filter(arg => arg !== '--execute')
if (unknown.length) throw Error(`Unknown argument ${unknown[0]}. Usage: platform-sweep.mjs [--execute]`)
const execute = args.includes('--execute')
for (const name of ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'PLATFORM_PARTNER_SECRET_KEY']) {
  if (!process.env[name]) throw Error(`${name} required`)
}

const pool = database(), connection = chain(), partner = partnerSigner(), config = configAddress()
const services = {}
const feeService = phase => (services[phase] ??= platformFeeService(phase, { pool, connection, config, partner }))
const revenue = createPlatformRevenue({ pool, partnerWallet: platformTreasuryWallet(partner.publicKey) })
try {
  const report = await runPlatformSweep({ execute,
    dbcEnabled: process.env.PLATFORM_DBC_COLLECTION_ENABLED === 'true',
    listFees: () => listPlatformFees({ pool, feeService }),
    feeService, summary: () => platformRevenueSummary(pool), allocate: revenue.allocate,
    connection, signer: partner,
    balanceOf: address => connection.getBalance(new PublicKey(address), 'confirmed'),
    log: line => console.error(line) })
  console.log(JSON.stringify(report, null, 2))
  console.log(sweepHeadline(report))
  if (!report.ok) process.exitCode = 1
} finally { await pool.end() }
