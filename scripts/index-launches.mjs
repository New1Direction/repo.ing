import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'

if (!process.env.DATABASE_URL || !process.env.SOLANA_RPC_URL || !process.env.DBC_CONFIG) {
  throw new Error('DATABASE_URL, SOLANA_RPC_URL, and DBC_CONFIG are required')
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const connection = new Connection(process.env.SOLANA_RPC_URL, 'finalized')
  const verify = createLaunchEvidenceVerifier({ connection, config: process.env.DBC_CONFIG })
  const results = await createLaunchIndexer({ pool, verify }).runOnce()
  console.log(JSON.stringify(results))
  if (results.some(result => ['invalid', 'mismatch', 'missing', 'unavailable'].includes(result.state))) process.exitCode = 1
} finally { await pool.end() }
