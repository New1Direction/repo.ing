import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { agreeGraduation, evidenceJSON } from './graduation-state.mjs'
import { readGenesisHash } from './rpc-usage.mjs'
import { readStockGraduationState, recordStockDammCheckpoints, recordStockGraduationEvent, recordStockObservation, stockQuoteOf } from './stock-graduation.mjs'
import { indexStockDammTrades, STOCK_DAMM_QUARANTINE } from './stock-damm-trades.mjs'

// Worker job for stock-paired markets (docs/STOCK_QUOTES.md), the stock counterpart of src/graduation-readiness.mjs, which lists
// SOL markets only. Per market, under its own advisory lock and with two providers agreeing on every read:
//   1. a reading of the curve's progress into stock_graduation_observations;
//   2. once migrated, the migration proof into stock_graduation_events (once; a different proof later is a conflict);
//   3. every swap on the graduated pool into stock_trade_events (venue 'damm'), unmatched swaps quarantined, never skipped;
//   4. DAMM fee checkpoints of both locked positions into stock_damm_fee_checkpoints, by the stock fee policy;
//   5. hooks: later jobs (reconciliation) run inside the same pass and lock, with the verified state.
// A failure is loud: the market's result is REVIEW with a code and a STOCK_GRADUATION_REVIEW alert, and an open swap
// quarantine keeps it REVIEW until the swap parses. Alerts share graduation_alerts (operator page and health), with stock kinds
// only, so nothing meant for SOL markets (public milestone posts) ever reads them.
export const STOCK_MARKET_SQL = `select m.github_repo_id::text as "githubRepoId",m.id,m.mint,m.pool,m.creator_wallet as "creatorWallet",
  m.quote_asset_id as "quoteAssetId",m.quote_mint as "quoteMint",r.full_name as "fullName"
  from markets m join repositories r on r.github_repo_id=m.github_repo_id where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.quote_asset_id is not null`
export const STOCK_GRADUATED = 'STOCK_GRADUATED'
export const STOCK_GRADUATION_REVIEW = 'STOCK_GRADUATION_REVIEW'
const LOCAL_RPC = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/

export const stockGraduationError = error => /^[A-Z][A-Z_]{3,60}$/.test(error?.code ?? '') ? error.code
  : /^[A-Z][A-Z_]{3,60}$/.test(error?.message ?? '') ? error.message : 'EVIDENCE_UNAVAILABLE'

async function emitAlert(db, repoId, kind, key, detail) {
  const { rows } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing returning id,kind,github_repo_id::text as "repoId",created_at as "createdAt"`,
  [`${repoId ?? 'protocol'}:${kind}:${key}`, repoId, kind, evidenceJSON(detail)])
  return rows[0] ?? null
}

// hooks: [{ name, run({ db, market, quote, state, connection, verification }) }]: run in order after the pass's ledgers are
// written, each result under its name. A hook that throws makes the market REVIEW, like any other step.
export function createStockGraduationMonitor({ pool, connection, verification, config, env = process.env, hooks = [] }) {
  const registered = [...hooks]
  const coder = new CpAmm(connection)._program.coder
  async function processMarket(market) {
    const db = await pool.connect(), repoId = String(market.githubRepoId), alerts = []
    const notify = async (kind, key, detail) => { const alert = await emitAlert(db, repoId, kind, key, detail); if (alert) alerts.push(alert) }
    try {
      const lockKey = `stock-graduation:${repoId}`
      if (!(await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [lockKey])).rows[0].locked) return { repoId, status: 'BUSY', alerts }
      try {
        const quote = stockQuoteOf(market)
        const state = await readStockGraduationState({ connection, verification, config, market, env, db: pool })
        const { rows: [existing] } = await db.query('select migration_signature from stock_graduation_events where github_repo_id=$1', [repoId])
        if (existing && !state.migration) throw Error('GRADUATION_STATE_DISAGREEMENT')
        // The proof first, so a graduated reading is never public without it; then the reading itself, before trade indexing,
        // so a problem there never hides progress.
        if (state.migration) await recordStockGraduationEvent(db, state)
        const observed = await recordStockObservation(db, state)
        let trades = null, checkpoints = []
        if (state.migration) {
          await notify(STOCK_GRADUATED, state.migration.signature, { signature: state.migration.signature, pool: state.migration.pool, slot: state.migration.slot,
            assetId: quote.assetId })
          trades = await indexStockDammTrades({ db, connection, verification, market, quote, coder,
            graduation: { pool: state.migration.pool, signature: state.migration.signature, slot: state.migration.slot } })
          alerts.push(...trades.alerts)
          checkpoints = await recordStockDammCheckpoints(db, state)
        }
        const hookResults = {}
        for (const hook of registered) hookResults[hook.name] = await hook.run({ db, market, quote, state, connection, verification })
        const quarantined = trades?.openQuarantines ?? 0, disabled = Boolean(state.migration) && !state.dammPoolEnabled
        if (disabled) await notify(STOCK_GRADUATION_REVIEW, 'DAMM_POOL_DISABLED', { code: 'DAMM_POOL_DISABLED', pool: state.migration.pool })
        const code = quarantined ? STOCK_DAMM_QUARANTINE : disabled ? 'DAMM_POOL_DISABLED' : null
        return { repoId, status: code ? 'REVIEW' : 'VERIFIED', ...(code ? { code } : {}), assetId: quote.assetId,
          phase: state.phase, curve: state.status, progressPercent: state.progressPercent, observed, migration: state.migration?.signature ?? null,
          dammPool: state.destination?.pool ?? null,
          trades: trades && { transactions: trades.transactions, remaining: trades.remaining, inserted: trades.inserted, quarantined: trades.quarantined },
          checkpoints, hooks: hookResults, alerts }
      } catch (error) {
        const code = stockGraduationError(error)
        await notify(STOCK_GRADUATION_REVIEW, code, { code })
        return { repoId, status: 'REVIEW', code, alerts }
      } finally { await db.query('select pg_advisory_unlock(hashtextextended($1,0))', [lockKey]) }
    } finally { db.release() }
  }
  async function runOnce() {
    // No stock-paired market, no RPC: the job costs nothing until one exists.
    const { rows: markets } = await pool.query(STOCK_MARKET_SQL)
    if (!markets.length) return []
    try {
      if (!verification) throw Error('VERIFICATION_RPC_REQUIRED')
      agreeGraduation(...await Promise.all([connection, verification].map(c => readGenesisHash(c))))
      await Promise.all([connection, verification].map(c => c.getSlot('finalized')))
    } catch (error) {
      const code = stockGraduationError(error)
      const alert = await emitAlert(pool, null, STOCK_GRADUATION_REVIEW, code, { code })
      return [{ repoId: null, status: 'REVIEW', code, alerts: alert ? [alert] : [] }]
    }
    const results = []
    for (const market of markets) {
      results.push(await processMarket(market))
      if (!LOCAL_RPC.test(connection.rpcEndpoint)) await new Promise(resolve => setTimeout(resolve, 2000))
    }
    return results
  }
  // PR-D's reconciliation (and any later stock job that needs the verified state) registers here.
  const addHook = hook => {
    if (!hook || typeof hook.name !== 'string' || typeof hook.run !== 'function') throw Error('A stock graduation hook needs a name and a run function')
    registered.push(hook)
  }
  return { runOnce, processMarket, addHook }
}

// The worker's stock graduation pass (scripts/run-worker.mjs runs it un-awaited on its own schedule, so it must never reject):
// one log line, BigInts as text, whatever a hook returns; a line that cannot be written is replaced by a fixed one. Returns true
// when the worker should exit non-zero (a REVIEW, or the pass or its report failing).
export async function stockGraduationPass(monitor, log = line => console.log(line)) {
  try {
    const result = {}
    try { result.stockGraduation = await monitor.runOnce() } catch { result.stockGraduationError = 'Stock graduation unavailable' }
    const failed = Boolean(result.stockGraduationError || result.stockGraduation?.some(item => item.status === 'REVIEW'))
    if (result.stockGraduationError || result.stockGraduation?.length) {
      log(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
    }
    return failed
  } catch {
    try { log(JSON.stringify({ stockGraduationError: 'STOCK_GRADUATION_REPORT_UNAVAILABLE' })) } catch { /* nothing left to report with */ }
    return true
  }
}

// The operator view of stock-paired markets (the SOL graduationOperatorView lists SOL markets only): each one's latest reading,
// migration proof, DAMM fee checkpoints so far and open swap quarantines.
export async function stockGraduationOperatorView(pool) {
  const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.quote_asset_id as "assetId", r.full_name as "fullName",
      o.observed_at as "observedAt", o.quote_reserve::text as "reserveBaseUnits", o.migration_threshold::text as "thresholdBaseUnits", o.is_migrated as "isMigrated",
      e.damm_pool as "dammPool", e.migration_signature as "migrationSignature",
      (select coalesce(sum(c.launcher_credit),0)::text from stock_damm_fee_checkpoints c where c.github_repo_id=m.github_repo_id) as "dammLauncherCredited",
      (select coalesce(sum(c.accumulator_credit),0)::text from stock_damm_fee_checkpoints c where c.github_repo_id=m.github_repo_id) as "dammAccumulatorCredited",
      (select count(*)::int from graduation_alerts a where a.github_repo_id=m.github_repo_id and a.kind=$1 and a.acknowledged_at is null) as "openQuarantines"
    from markets m join repositories r on r.github_repo_id=m.github_repo_id
    left join lateral (select observed_at, quote_reserve, migration_threshold, is_migrated from stock_graduation_observations s
      where s.github_repo_id=m.github_repo_id order by s.observed_at desc, s.id desc limit 1) o on true
    left join stock_graduation_events e on e.github_repo_id=m.github_repo_id
    where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.quote_asset_id is not null
    order by m.github_repo_id`, [STOCK_DAMM_QUARANTINE])
  return rows.map(row => ({ ...row, phase: row.dammPool ? 'GRADUATED' : row.observedAt ? 'CURVE' : 'UNOBSERVED',
    progressPercent: row.dammPool ? 100 : row.reserveBaseUnits && BigInt(row.thresholdBaseUnits) > 0n
      ? Math.min(100, Number(BigInt(row.reserveBaseUnits) * 10000n / BigInt(row.thresholdBaseUnits)) / 100) : null }))
}
