import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { createReconciler } from '../src/reconcile.mjs'
import { tradingEarlyAccessConfig } from '../src/early-access.mjs'

const [repoId, config] = process.argv.slice(2)
if (!repoId || !config || !process.env.DATABASE_URL) {
  throw new Error('Usage: DATABASE_URL=... node scripts/reconcile-repo.mjs GITHUB_REPO_ID DBC_CONFIG')
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const result = await createReconciler({ pool,
    connection: new Connection(process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899', 'finalized'),
    config, earlyAccess: tradingEarlyAccessConfig(), earlyAccessGraduated: true }).reconcile(repoId)
  console.log(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
} finally {
  await pool.end()
}
