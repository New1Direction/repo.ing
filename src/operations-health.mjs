import { OPERATING_WALLETS } from './operating-wallet-alerts.mjs'
import { platformRevenueSummary } from './platform-revenue.mjs'
import { liquidityReserveSummary } from './liquidity-deployment.mjs'
import { tradeOutcomeSummary } from './trade-outcomes.mjs'
import { tradeCanarySummary } from './trade-canary.mjs'

// Read-only operator health view. Every section settles on its own so one failing RPC or query
// never blanks the others; nothing here signs, spends, or mutates state.

const SECTION_TIMEOUT_MS = 8000
export const ATTENTION_STATUSES = Object.freeze(['prepared', 'submitted', 'ambiguous'])
const threshold = key => OPERATING_WALLETS.find(w => w.key === key)

// Public addresses only; the caller derives them from signers and never passes key material in.
export function healthWallets({ creator, partner, custody, team }, env = process.env) {
  const payout = threshold('OPS_PAYOUT_WALLET'), collection = threshold('OPS_COLLECTION_WALLET')
  return [
    { id: 'creator', label: 'Creator / operating wallet', purpose: 'Pays builder payouts and launch costs', address: creator, minimumLamports: payout.minimumLamports, monitorKey: payout.key, token: false },
    { id: 'partner', label: 'Partner fee claimer', purpose: 'Claims platform partner fees', address: partner, minimumLamports: collection.minimumLamports, monitorKey: collection.key, token: false },
    { id: 'custody', label: 'Platform custody', purpose: 'Holds claimed platform revenue and custody buybacks', address: custody, minimumLamports: null, monitorKey: null, token: true },
    { id: 'team', label: 'Team wallet', purpose: 'Team $REPOING buybacks', address: team, minimumLamports: null, monitorKey: null, token: true },
  ].map(w => ({ ...w, monitored: !w.monitorKey ? null : !env[w.monitorKey] ? 'unset' : env[w.monitorKey] === w.address ? 'match' : 'different' }))
}

// Same comparison as the worker's OPS_WALLET_LOW alert: strictly below the minimum is low.
export function classifyWalletBalance(balanceLamports, minimumLamports) {
  if (balanceLamports === null || balanceLamports === undefined) return 'unknown'
  if (minimumLamports === null || minimumLamports === undefined) return 'unmonitored'
  return BigInt(balanceLamports) < BigInt(minimumLamports) ? 'low' : 'ok'
}

// drizzle-kit applies every journal entry whose `when` is newer than the latest applied created_at.
export function migrationStatus(journal, { count, latest }) {
  const entries = journal?.entries ?? []
  const latestApplied = latest === null || latest === undefined ? null : Number(latest)
  const pending = entries.filter(e => latestApplied === null || e.when > latestApplied)
  const applied = entries.find(e => e.when === latestApplied)
  return { status: pending.length ? 'PENDING' : 'UP_TO_DATE', journalCount: entries.length, appliedCount: Number(count ?? 0),
    latestApplied: latestApplied === null ? null : new Date(latestApplied).toISOString(), latestAppliedTag: applied?.tag ?? null,
    latestJournalTag: entries.at(-1)?.tag ?? null, pending: pending.map(e => e.tag) }
}

export function buybackTotals(receipts) {
  const totals = { custody: 0n, team: 0n }
  for (const r of receipts) if (r.source in totals) totals[r.source] += BigInt(r.spentLamports)
  return { custody: totals.custody.toString(), team: totals.team.toString(), total: (totals.custody + totals.team).toString(), count: receipts.length }
}

export function revenueComparison(revenue, liquidity, buybacks) {
  const liquidityAllocated = BigInt(revenue.allocated.liquidity), liquidityAdded = BigInt(liquidity.settled)
  const buybackAllocated = BigInt(revenue.allocated.buyback), custodyDisclosed = BigInt(buybacks.custody)
  return {
    claimed: revenue.claimed.total, available: revenue.available, allocated: revenue.allocated, spent: revenue.spent,
    buybackReserve: revenue.buybackReserve, policy: revenue.activePolicy,
    buybacks, liquidity: { allocated: liquidityAllocated.toString(), added: liquidityAdded.toString(), open: liquidity.open,
      owed: (liquidityAllocated > liquidityAdded ? liquidityAllocated - liquidityAdded : 0n).toString() },
    buybackAllocatedNotDisclosed: (buybackAllocated > custodyDisclosed ? buybackAllocated - custodyDisclosed : 0n).toString(),
  }
}

const exposed = message => Object.assign(Error(message), { expose: true })
const withTimeout = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(exposed(`Timed out after ${ms / 1000}s`)), ms) })])
    .finally(() => clearTimeout(timer))
}

// Only messages we raise ourselves reach the page; driver and RPC errors stay generic.
export async function settleSection(name, load, { timeoutMs = SECTION_TIMEOUT_MS, log = console.error } = {}) {
  try { return { ok: true, data: await withTimeout(Promise.resolve().then(load), timeoutMs) } }
  catch (error) {
    log(`operations health: ${name} unavailable`, error?.code ?? error?.name ?? 'error')
    return { ok: false, error: error?.expose ? error.message : `${name} is temporarily unavailable.` }
  }
}

async function walletRow(connection, wallet, readToken) {
  if (!wallet.address) return { ...wallet, error: 'Signer not configured or unreadable' }
  const [balance, token] = await Promise.allSettled([connection.getBalance(wallet.address), wallet.token ? readToken(wallet.address) : null])
  const balanceLamports = balance.status === 'fulfilled' ? String(balance.value) : null
  return { ...wallet, balanceLamports, state: classifyWalletBalance(balanceLamports, wallet.minimumLamports),
    tokenBaseUnits: wallet.token && token.status === 'fulfilled' ? token.value : null,
    error: balance.status === 'rejected' ? 'Balance unavailable' : null }
}

export async function loadOperationsHealth({ db, connection, wallets, readToken, loadBuybacks, cspStats, journal, now = Date.now, timeoutMs, log } = {}) {
  const needDb = () => { if (!db) throw exposed('DATABASE_URL is not configured') }
  const options = { timeoutMs, log }
  const [walletSection, launches, alerts, revenue, migrations, csp, trades, canary] = await Promise.all([
    settleSection('Wallets', async () => {
      if (!connection) throw exposed('SOLANA_RPC_URL is not configured')
      return Promise.all((await wallets()).map(w => walletRow(connection, w, readToken)))
    }, options),
    settleSection('Launches', async () => {
      needDb()
      const { rows } = await db.query(`select m.github_repo_id::text as "repoId", r.full_name as "fullName", m.status, m.mint, m.pool,
        m.launch_signature as signature, m.created_at as "createdAt" from markets m left join repositories r on r.github_repo_id=m.github_repo_id
        where m.status = any($1) order by m.created_at limit 100`, [ATTENTION_STATUSES])
      return rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), ageMs: now() - new Date(row.createdAt).getTime() }))
    }, options),
    settleSection('Alerts', async () => {
      needDb()
      const { rows } = await db.query(`select kind, count(*)::int as count, max(created_at) as latest from graduation_alerts
        where acknowledged_at is null group by kind order by max(created_at) desc`)
      return rows.map(row => ({ ...row, latest: new Date(row.latest).toISOString() }))
    }, options),
    settleSection('Revenue', async () => {
      needDb()
      const [summary, liquidity, receipts] = await Promise.all([platformRevenueSummary(db), liquidityReserveSummary(db), loadBuybacks()])
      return revenueComparison(summary, liquidity, buybackTotals(receipts))
    }, options),
    settleSection('Migrations', async () => {
      needDb()
      let row
      try { ({ rows: [row] } = await db.query('select count(*)::int as count, max(created_at)::text as latest from drizzle.__drizzle_migrations')) }
      catch (error) { if (error?.code === '42P01' || error?.code === '3F000') throw exposed('drizzle.__drizzle_migrations not found'); throw error }
      return migrationStatus(journal, row)
    }, options),
    settleSection('CSP reports', () => cspStats.snapshot(), options),
    settleSection('Trades', async () => {
      needDb()
      try { return await tradeOutcomeSummary(db) }
      catch (error) { if (error?.code === '42P01') throw exposed('trade_outcomes table not migrated yet'); throw error }
    }, options),
    settleSection('Canary', async () => {
      needDb()
      try { return await tradeCanarySummary(db) }
      catch (error) { if (error?.code === '42P01') throw exposed('trade_canary_status table not migrated yet'); throw error }
    }, options),
  ])
  return { generatedAt: new Date(now()).toISOString(), wallets: walletSection, launches, alerts, revenue, migrations, csp, trades, canary }
}
