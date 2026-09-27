import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'

const { DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc, DBC_CONFIG: config } = process.env
if (!databaseUrl || !rpc || !config) throw new Error('DATABASE_URL, SOLANA_RPC_URL, and DBC_CONFIG are required')
const once = process.argv.includes('--once')
const pool = new pg.Pool({ connectionString: databaseUrl })
const worker = createExternalFeeIndexer({ pool, connection: new Connection(rpc, 'finalized'), config })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  do {
    const results = await worker.runOnce()
    console.log(JSON.stringify(results, (_, value) => typeof value === 'bigint' ? value.toString() : value))
    if (results.some(result => result.status === 'ERROR')) process.exitCode = 1
    if (!once) await delay(5000)
  } while (!once)
} finally { await pool.end() }
