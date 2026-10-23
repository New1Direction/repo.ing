import { createDatabasePool } from '../src/database-pool.mjs'
import { Connection } from '@solana/web3.js'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { readFileSync } from 'node:fs'
import { createCustodyRecovery } from '../src/custody-recovery.mjs'

let custodyRecovery = null
if (process.env.CUSTODY_RECOVERY_MANIFEST !== undefined) {
  try {
    custodyRecovery = JSON.parse(readFileSync(process.env.CUSTODY_RECOVERY_MANIFEST, 'utf8'))
    if (custodyRecovery === null) throw Error('Empty manifest')
    createCustodyRecovery(custodyRecovery)
  } catch { throw Error('Cannot load custody recovery manifest; review public bindings before starting accounting') }
}
const { DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc, DBC_CONFIG: config } = process.env
if (!databaseUrl || !rpc || !config) throw new Error('DATABASE_URL, SOLANA_RPC_URL, and DBC_CONFIG are required')
const once = process.argv.includes('--once')
const pool = createDatabasePool({ connectionString: databaseUrl })
const worker = createExternalFeeIndexer({ pool, connection: new Connection(rpc, 'finalized'), config, custodyRecovery })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  do {
    const results = await worker.runOnce()
    console.log(JSON.stringify(results, (_, value) => typeof value === 'bigint' ? value.toString() : value))
    if (results.some(result => result.status === 'ERROR')) process.exitCode = 1
    if (!once) await delay(5000)
  } while (!once)
} finally { await pool.end() }
