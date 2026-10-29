// Standalone wallet funding run (owner 2026-10-29). The transparency job that records where each trading wallet's first SOL came
// from (src/wallet-funding.mjs) lived in the main worker, which no longer runs, so wallets that started trading after 2026-10-22
// have no funding record. This runs only that read-only-on-chain job: up to PER_RUN due wallets per invocation (a systemd timer
// repeats it). Env: FUNDING_DATABASE_URL, else RECOVERY_CHART_DATABASE_URL (select on trade_events/damm_trade_events, select/insert/
// update on wallet_funding); SOLANA_RPC_URL. --dry-run: list the due wallets, check nothing.
import pg from 'pg'
import { Connection } from '@solana/web3.js'
import { checkWalletFunding, dueFundingWallets, FUNDING_LIMITS } from '../src/wallet-funding.mjs'

const PER_RUN = 60
const dryRun = process.argv.includes('--dry-run')
const report = o => process.stdout.write(`${JSON.stringify({ lane: 'funding', ...o })}\n`)
const databaseUrl = process.env.FUNDING_DATABASE_URL || process.env.RECOVERY_CHART_DATABASE_URL, rpcUrl = process.env.SOLANA_RPC_URL
if (!databaseUrl || !rpcUrl) { report({ status: 'CONFIG_MISSING', database: Boolean(databaseUrl), rpc: Boolean(rpcUrl) }); process.exit(1) }

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 15_000 })
const connection = new Connection(rpcUrl, 'finalized'), limits = { ...FUNDING_LIMITS, perRun: PER_RUN }
try {
  const due = await dueFundingWallets(pool, { limits })
  if (dryRun) report({ status: 'DRY_RUN_COMPLETED', due: due.length })
  else {
    const counts = {}
    for (const wallet of due) {
      let status
      try { status = await checkWalletFunding(pool, connection, wallet, { limits }) } catch { status = 'error' }
      counts[status] = (counts[status] ?? 0) + 1
    }
    report({ status: 'COMPLETED', checked: due.length, counts })
  }
} catch (error) {
  // Never print the raw error: it can carry an RPC URL with its key.
  report({ status: 'FAILED', code: error?.code ?? null, reason: String(error?.message ?? error).replace(/https?:\/\/\S+/g, '<url>').slice(0, 160) })
  process.exitCode = 1
} finally { await pool.end() }
