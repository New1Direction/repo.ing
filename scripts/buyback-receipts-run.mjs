// Standalone buyback receipts run (owner 2026-10-29: "make sure the website is showing ... buyback"). The main worker
// (scripts/run-worker.mjs) carried this job and is not running, so /stats stopped recording buybacks after 2026-10-19.
// This runs only that job: finalized $REPOING buys by the custody, platform-fee and team wallets go to buyback_receipts,
// a read-only disclosure that never debits the revenue ledger or spends anything. One run per invocation (a systemd timer
// repeats it). Env: BUYBACK_DATABASE_URL, else RECOVERY_CHART_DATABASE_URL (a role with select/insert on buyback_receipts
// and select/insert/update on buyback_receipt_cursors); SOLANA_RPC_URL. --dry-run: list what would be recorded, write nothing.
import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { createBuybackReceiptsJob } from '../src/buyback-receipts-job.mjs'

const dryRun = process.argv.includes('--dry-run')
const report = o => process.stdout.write(`${JSON.stringify({ lane: 'buybacks', ...o })}\n`)
const databaseUrl = process.env.BUYBACK_DATABASE_URL || process.env.RECOVERY_CHART_DATABASE_URL, rpcUrl = process.env.SOLANA_RPC_URL
if (!databaseUrl || !rpcUrl) { report({ status: 'CONFIG_MISSING', database: Boolean(databaseUrl), rpc: Boolean(rpcUrl) }); process.exit(1) }

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 15_000 })
// Dry run: reads go through; a receipt insert answers as if it were new (so the job lists it) and the cursor never moves.
const db = dryRun ? { query: (text, params) => /^\s*insert into buyback_receipts\s/i.test(text) ? Promise.resolve({ rows: [{ signature: params[0] }] })
  : /^\s*insert into buyback_receipt_cursors\s/i.test(text) ? Promise.resolve({ rows: [] }) : pool.query(text, params) } : pool
const job = createBuybackReceiptsJob({ pool: db, connection: new Connection(rpcUrl, 'finalized') })
try {
  const results = await job.runOnce()
  report({ status: dryRun ? 'DRY_RUN_COMPLETED' : 'COMPLETED', results })
} catch (error) {
  // Never print the raw error: it can carry an RPC URL with its key.
  report({ status: 'FAILED', code: error?.code ?? null, reason: String(error?.message ?? error).replace(/https?:\/\/\S+/g, '<url>').slice(0, 160) })
  process.exitCode = 1
} finally { await pool.end() }
