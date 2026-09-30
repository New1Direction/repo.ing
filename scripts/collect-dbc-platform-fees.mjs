// Operator CLI. Review and simulation do not broadcast. Claim consumes only an
// exact, unexpired review file produced by this tool; no unattended sweep mode.
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import bs58 from 'bs58'
import { Connection, Keypair } from '@solana/web3.js'
import { DBC_MAX_NETWORK_FEE_LAMPORTS, createDbcPlatformFees } from '../src/platform-dbc-fees.mjs'

const [mode, argument] = process.argv.slice(2)
if (!['review', 'simulate', 'claim'].includes(mode) || !argument) throw Error('Usage: collect-dbc-platform-fees.mjs review REPO_ID | simulate REVIEW_FILE | claim REVIEW_FILE')
for (const name of ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'PLATFORM_PARTNER_SECRET_KEY', 'PLATFORM_FEE_TREASURY_WALLET']) {
  if (!process.env[name]) throw Error(`${name} required`)
}
const secret = process.env.PLATFORM_PARTNER_SECRET_KEY.trim()
const partner = Keypair.fromSecretKey(secret.startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret))
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const service = createDbcPlatformFees({ pool, connection: new Connection(process.env.SOLANA_RPC_URL, 'finalized'),
    config: process.env.DBC_CONFIG, partner, verification: process.env.GRADUATION_VERIFICATION_RPC_URL ?
      new Connection(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') : null })
  if (mode === 'review') {
    const current = await service.status(argument)
    const review = { purpose: 'platform-fee-review', phase: 'DBC', repoId: current.repoId,
      receiver: current.receiver, amount: current.available, termsHash: current.termsHash,
      maxNetworkFeeLamports: String(DBC_MAX_NETWORK_FEE_LAMPORTS), expiresAt: Date.now() + 10 * 60_000 }
    console.log(JSON.stringify({ current, review }, null, 2))
  } else {
    const { review } = JSON.parse(await readFile(argument, 'utf8'))
    console.log(JSON.stringify(await service.claim({ review, simulateOnly: mode === 'simulate' }), null, 2))
  }
} finally { await pool.end() }
