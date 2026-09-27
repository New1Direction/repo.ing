// Idempotent evidence replay. Never derives credits from percentages of volume,
// never resets the live cursor, and never sends a transaction.
import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { createFeeAccrual } from '../src/fee-accrual.mjs'

const write = process.argv.includes('--apply')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
if (!process.env.DATABASE_URL || !process.env.SOLANA_RPC_URL || !process.env.DBC_CONFIG) throw Error('Database, RPC and approved config required')
try {
  const { rows } = await pool.query(`select distinct f.github_repo_id::text as "repoId", f.signature
    from fee_events f join markets m on m.github_repo_id=f.github_repo_id
    where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'
    and not exists (select 1 from discovery_fee_events p where p.signature=f.signature and p.event_index=f.event_index)
    order by "repoId", f.signature`)
  if (rows.length > 5000) throw Error('Backfill exceeds the reviewed 5000-signature bound')
  console.log(JSON.stringify({ mode: write ? 'apply-finalized-evidence' : 'audit', signatures: rows.length,
    repositories: [...new Set(rows.map(r => r.repoId))] }))
  if (write) {
    const fees = createFeeAccrual({ pool, connection: new Connection(process.env.SOLANA_RPC_URL, 'finalized'), config: process.env.DBC_CONFIG })
    for (const row of rows) {
      const result = await fees.recordTradeFees({ githubRepoId: row.repoId, signatures: [row.signature], allowNonSwap: true })
      if (result.creditedBaseUnits !== 0n) throw Error('Existing creator evidence changed during partner replay; stop for review')
      console.log(JSON.stringify({ repoId: row.repoId, signature: row.signature, replayed: true }))
    }
  }
} finally { await pool.end() }
