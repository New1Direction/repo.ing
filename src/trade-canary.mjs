import { PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'
import { LIGHTHOUSE_PROGRAM, matchesReviewedTransaction } from './launch-wallet-assertions.mjs'
import { prepareCheckedTrade } from './trade-prepare.mjs'
import { preparedFromRecord, serializeUnsigned } from './trade-record.mjs'
import { scrubError } from './trade-outcomes.mjs'

// Operator-only trade canary. Every few minutes the worker runs the real prepare path for a small buy on a few live
// markets with a funded wallet as the UNSIGNED fee payer, then only simulates: nothing is ever signed or sent.
// Each run also appends a Phantom-style Lighthouse assertion and requires the review check to accept it and the
// simulation to still pass inside the prepared compute-unit limit. Results go to trade_canary_status (operator health
// page); a market failing twice in a row, or every market failing at once, raises one graduation_alerts row per hour.
export const CANARY_AMOUNT_LAMPORTS = 10_000_000n
export const CANARY_PAYER = OFFICIAL_TOKEN.teamWallet
export const CANARY_INTERVAL_MS = 5 * 60 * 1000
export const CANARY_CURVE_MARKETS = 2
export const CANARY_FAILURE_THRESHOLD = 2
export const TRADE_CANARY_FAILING = 'TRADE_CANARY_FAILING'
const STALE_STREAK = '30 minutes'
const SWAP_PROGRAMS = { curve: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', graduated: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' }
const LOG_TAIL = 6

// Lighthouse AssertAccountInfo (5), log level Silent (0), Owner (2) == System Program, operator Equal (0), on the
// fee payer: the shape of assertion Phantom appends. It holds for any funded wallet, so it must never fail a swap.
export function lighthouseAssertion(payer) {
  return new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM),
    keys: [{ pubkey: payer, isSigner: false, isWritable: false }],
    data: Buffer.concat([Buffer.from([5, 0, 2]), SystemProgram.programId.toBuffer(), Buffer.from([0])]) })
}

async function simulate(connection, transaction, label) {
  const encoded = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
  const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(encoded),
    { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true })
  if (value.err) throw Error(`${label} simulation failed: ${JSON.stringify(value.err)} ${(value.logs ?? []).slice(-LOG_TAIL).join(' | ')}`)
  return value
}

const invoked = (logs, program) => (logs ?? []).includes(`Program ${program} invoke [1]`) && (logs ?? []).includes(`Program ${program} success`)

// One market: the real prepare path, a persisted-record round trip, and two simulations. Throws on any failure.
export async function probeMarket({ engine, connection, repoId, payer = CANARY_PAYER, amountLamports = CANARY_AMOUNT_LAMPORTS, expectPhase = null }) {
  const { prepared, costs } = await prepareCheckedTrade({ engine, connection, direction: 'buy', githubRepoId: repoId,
    wallet: payer, amountBaseUnits: amountLamports.toString() })
  if (expectPhase && prepared.phase !== expectPhase) throw Error(`Market traded as ${prepared.phase}, expected ${expectPhase}`)
  // What another instance would rebuild from trade_sessions must be byte-identical to what the wallet signs.
  const restored = preparedFromRecord(JSON.parse(JSON.stringify(prepared.record)))
  if (serializeUnsigned(restored.transaction) !== prepared.record.transaction ||
      !Buffer.from(restored.transaction.serializeMessage()).equals(Buffer.from(prepared.record.message, 'base64'))) {
    throw Error('Prepared trade record does not round-trip')
  }
  const program = SWAP_PROGRAMS[prepared.phase], limit = prepared.priorityFee.computeUnitLimit
  const plain = await simulate(connection, restored.transaction, 'Prepared trade')
  if (!invoked(plain.logs, program)) throw Error('Prepared trade simulation did not run the swap')
  const asserted = Transaction.from(Buffer.from(prepared.record.transaction, 'base64')).add(lighthouseAssertion(new PublicKey(payer)))
  if (!matchesReviewedTransaction(Buffer.from(prepared.record.message, 'base64'), asserted)) {
    throw Error('Review check refused a wallet-appended Lighthouse assertion')
  }
  const withAssertion = await simulate(connection, asserted, 'Wallet-asserted trade')
  if (!invoked(withAssertion.logs, program) || !invoked(withAssertion.logs, LIGHTHOUSE_PROGRAM)) {
    throw Error('Wallet-asserted trade simulation did not run the swap and assertion')
  }
  if (!(withAssertion.unitsConsumed <= limit)) throw Error(`Wallet-asserted trade used ${withAssertion.unitsConsumed} of ${limit} compute units`)
  return { phase: prepared.phase, computeUnitLimit: limit, unitsConsumed: plain.unitsConsumed, unitsWithAssertion: withAssertion.unitsConsumed,
    priorityFeeLamports: prepared.priorityFee.lamports, minimumAmountOut: prepared.minimumAmountOut.toString(), networkFee: costs.networkFee }
}

// The official market plus the most-traded active curve markets (7-day SOL volume, then all-time).
export async function selectCanaryMarkets(db, { isMigrated, officialRepoId = OFFICIAL_TOKEN.repoId, curveMarkets = CANARY_CURVE_MARKETS }) {
  const { rows } = await db.query(`select m.github_repo_id::text as "repoId", m.token_symbol as symbol,
      sum(case when t.traded_at > now() - interval '7 days' then (case when t.direction = 'buy' then t.input_base_units else t.output_base_units end)::numeric else 0 end) as recent,
      sum((case when t.direction = 'buy' then t.input_base_units else t.output_base_units end)::numeric) as total
    from markets m join trade_events t on t.pool = m.pool
    where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' and m.github_repo_id <> $1
      and m.early_access_end is null and m.transfer_hook_program is null
    group by m.github_repo_id, m.token_symbol order by recent desc, total desc limit 10`, [officialRepoId])
  const { rows: [official] } = await db.query('select token_symbol as symbol from markets where github_repo_id = $1', [officialRepoId])
  const picked = []
  for (const row of rows) {
    if (picked.length >= curveMarkets) break
    try { if (!await isMigrated(row.repoId)) picked.push({ repoId: row.repoId, symbol: row.symbol, expectPhase: 'curve' }) }
    catch { /* A market that cannot be read is skipped here; only the chosen markets are judged. */ }
  }
  return [{ repoId: String(officialRepoId), symbol: official?.symbol ?? OFFICIAL_TOKEN.symbol, expectPhase: 'graduated' }, ...picked]
}

// Pure alert rule: a market failing CANARY_FAILURE_THRESHOLD runs in a row, or every market failing in one run.
export function canaryAlerts(results, threshold = CANARY_FAILURE_THRESHOLD) {
  const alerts = results.filter(r => !r.ok && r.consecutiveFailures >= threshold)
    .map(r => ({ scope: r.repoId, repoId: r.repoId, symbol: r.symbol, error: r.error, consecutiveFailures: r.consecutiveFailures }))
  if (results.length && results.every(r => !r.ok)) {
    alerts.push({ scope: 'all', repoId: null, symbol: null, error: results.map(r => `${r.symbol ?? r.repoId}: ${r.error}`).join('; ').slice(0, 500),
      consecutiveFailures: Math.min(...results.map(r => r.consecutiveFailures)) })
  }
  return alerts
}

async function recordResult(db, result, at) {
  const { rows: [row] } = await db.query(`insert into trade_canary_status(github_repo_id, symbol, phase, ok, consecutive_failures, last_error,
      detail, last_run_at, last_ok_at) values($1, $2, $3, $4, case when $4 then 0 else 1 end, $5, $6, $7, case when $4 then $7::timestamptz end)
    on conflict (github_repo_id) do update set symbol = excluded.symbol, phase = coalesce(excluded.phase, trade_canary_status.phase),
      ok = excluded.ok, last_error = excluded.last_error, detail = excluded.detail, last_run_at = excluded.last_run_at,
      last_ok_at = coalesce(excluded.last_ok_at, trade_canary_status.last_ok_at),
      consecutive_failures = case when excluded.ok then 0
        when trade_canary_status.last_run_at < excluded.last_run_at - interval '${STALE_STREAK}' then 1
        else trade_canary_status.consecutive_failures + 1 end
    returning consecutive_failures as "consecutiveFailures"`,
  [result.repoId, result.symbol ?? null, result.phase ?? null, result.ok, result.error, result.detail ? JSON.stringify(result.detail) : null, at])
  return row.consecutiveFailures
}

// github_repo_id stays null (the market is in detail) so an alert never depends on a markets row.
async function raiseAlert(db, alert, at) {
  const hour = at.toISOString().slice(0, 13)
  const { rowCount } = await db.query(`insert into graduation_alerts(event_key, github_repo_id, kind, detail) values($1, $2, $3, $4)
    on conflict (event_key) do nothing`, [`trade-canary:${alert.scope}:${hour}`, null, TRADE_CANARY_FAILING,
    JSON.stringify({ code: TRADE_CANARY_FAILING, market: alert.repoId ?? 'all', symbol: alert.symbol, error: alert.error,
      consecutiveFailures: alert.consecutiveFailures })])
  return rowCount === 1
}

// probe and selectMarkets are injectable for tests; the defaults are the real paths.
export function createTradeCanary({ db, connection, router, payer = CANARY_PAYER, now = () => new Date(),
  selectMarkets = () => selectCanaryMarkets(db, { isMigrated: repoId => router.forPhase('graduated').isMigrated(repoId) }),
  probe = async market => probeMarket({ engine: await router(market.repoId), connection, repoId: market.repoId, payer, expectPhase: market.expectPhase }) }) {
  async function runOnce() {
    const markets = await selectMarkets(), at = now(), results = []
    for (const market of markets) {
      let result
      try { const detail = await probe(market); result = { ...market, ok: true, phase: detail.phase, error: null, detail } }
      catch (error) { result = { ...market, ok: false, phase: null, error: scrubError(error) ?? 'Canary failed', detail: null } }
      results.push({ ...result, consecutiveFailures: await recordResult(db, result, at) })
    }
    const alerted = []
    for (const alert of canaryAlerts(results)) if (await raiseAlert(db, alert, at)) alerted.push(alert.scope)
    return { markets: results.map(r => ({ repoId: r.repoId, symbol: r.symbol, ok: r.ok, phase: r.phase, error: r.error,
      consecutiveFailures: r.consecutiveFailures, unitsWithAssertion: r.detail?.unitsWithAssertion ?? null, computeUnitLimit: r.detail?.computeUnitLimit ?? null })), alerted }
  }
  return { runOnce }
}

// Operator health page: latest result per market checked in the last day.
export async function tradeCanarySummary(db) {
  const { rows } = await db.query(`select github_repo_id::text as "repoId", symbol, phase, ok, consecutive_failures as "consecutiveFailures",
      last_error as "lastError", detail, last_run_at as "lastRunAt", last_ok_at as "lastOkAt"
    from trade_canary_status where last_run_at > now() - interval '1 day' order by last_run_at desc, github_repo_id`)
  const markets = rows.map(row => ({ ...row, lastRunAt: new Date(row.lastRunAt).toISOString(), lastOkAt: row.lastOkAt ? new Date(row.lastOkAt).toISOString() : null }))
  return { lastRunAt: markets[0]?.lastRunAt ?? null, markets }
}
