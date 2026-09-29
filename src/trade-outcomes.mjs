// Operator-only trade landing telemetry. Each attempt (one prepare session) records its outcomes once; the health page
// summarizes the last 24h and a degraded hour raises one graduation_alerts row. Recording never blocks or fails a trade.
// Stored: market, phase, direction, amount, priority fee, error text, timings. Never a wallet, key or RPC URL.

export const TRADE_OUTCOMES = Object.freeze(['prepared', 'submitted', 'confirmed', 'expired', 'failed', 'verification_failed'])
export const TERMINAL_OUTCOMES = Object.freeze(['confirmed', 'expired', 'failed', 'verification_failed'])
export const TRADE_LANDING_DEGRADED = 'TRADE_LANDING_DEGRADED'
// Alert when, within the last hour, at least 3 attempts expired or failed, or success is below 90% over 5+ attempts.
export const ALERT_WINDOW_MS = 60 * 60 * 1000
export const ALERT_MIN_LOST = 3
export const ALERT_MIN_ATTEMPTS = 5
export const ALERT_MIN_SUCCESS_RATE = 0.9
const SUMMARY_WINDOW = '24 hours'
const ERROR_MAX_CHARS = 500

const intOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const textOrNull = value => value === null || value === undefined ? null : String(value)
// RPC client errors can quote the endpoint URL, whose query string holds the provider API key.
export const scrubError = error => error ? String(error?.message ?? error).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
  .replace(/api[-_]?key=\S+/gi, 'api-key=<redacted>').slice(0, ERROR_MAX_CHARS) : null

// One row from a prepared trade (or just a signature when the server session is gone).
export function outcomeRow({ attemptKey, outcome, prepared = null, signature = null, error = null, prepareToSignMs = null, signToConfirmMs = null }) {
  if (!TRADE_OUTCOMES.includes(outcome)) throw Error(`Unknown trade outcome ${outcome}`)
  if (typeof attemptKey !== 'string' || !attemptKey || attemptKey.length > 100) throw Error('Invalid trade attempt key')
  const fee = prepared?.priorityFee
  return { attemptKey, outcome, githubRepoId: textOrNull(prepared?.githubRepoId), mint: prepared?.mint ?? null,
    phase: prepared ? prepared.phase ?? 'curve' : null, direction: ['buy', 'sell'].includes(prepared?.direction) ? prepared.direction : null,
    amountIn: textOrNull(prepared?.amountIn), priorityFeeLamports: textOrNull(fee?.lamports), cuPrice: textOrNull(fee?.microLamports),
    cuLimit: intOrNull(fee?.computeUnitLimit), signature, error: scrubError(error),
    prepareToSignMs: intOrNull(prepareToSignMs), signToConfirmMs: intOrNull(signToConfirmMs) }
}

export async function recordTradeOutcome(db, fields) {
  const r = outcomeRow(fields)
  const { rowCount } = await db.query(`insert into trade_outcomes(attempt_key,outcome,github_repo_id,mint,phase,direction,amount_in,
      priority_fee_lamports,cu_price_micro_lamports,cu_limit,signature,error,prepare_to_sign_ms,sign_to_confirm_ms)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(attempt_key,outcome) do nothing`,
    [r.attemptKey, r.outcome, r.githubRepoId, r.mint, r.phase, r.direction, r.amountIn, r.priorityFeeLamports, r.cuPrice, r.cuLimit,
      r.signature, r.error, r.prepareToSignMs, r.signToConfirmMs])
  return rowCount === 1
}

// Terminal attempts in the window: lost = expired or failed; success = confirmed / all terminal.
export function landingAlertDecision({ confirmed = 0, expired = 0, failed = 0, verificationFailed = 0 }) {
  const attempts = confirmed + expired + failed + verificationFailed, lost = expired + failed
  const successRate = attempts ? confirmed / attempts : null
  const degraded = lost >= ALERT_MIN_LOST || (attempts >= ALERT_MIN_ATTEMPTS && successRate < ALERT_MIN_SUCCESS_RATE)
  return { degraded, attempts, lost, successRate }
}

// Best outcome per attempt: an attempt that confirmed after an early "expired" guess counts as confirmed.
const TERMINAL_PER_ATTEMPT = `select attempt_key, case when bool_or(outcome='confirmed') then 'confirmed'
    when bool_or(outcome='verification_failed') then 'verification_failed' when bool_or(outcome='failed') then 'failed'
    when bool_or(outcome='expired') then 'expired' end as terminal
  from trade_outcomes where created_at > $1 group by attempt_key`

export async function checkTradeLandingAlert(db, { now = Date.now } = {}) {
  const since = new Date(now() - ALERT_WINDOW_MS)
  const { rows } = await db.query(`select terminal, count(*)::int as count from (${TERMINAL_PER_ATTEMPT}) t
    where terminal is not null group by terminal`, [since])
  const count = kind => rows.find(row => row.terminal === kind)?.count ?? 0
  const decision = landingAlertDecision({ confirmed: count('confirmed'), expired: count('expired'), failed: count('failed'),
    verificationFailed: count('verification_failed') })
  if (!decision.degraded) return { ...decision, alerted: false }
  const hour = new Date(now()).toISOString().slice(0, 13)
  const { rowCount } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,null,$2,$3)
    on conflict(event_key) do nothing`, [`trade-landing:${hour}`, TRADE_LANDING_DEGRADED, JSON.stringify({ code: TRADE_LANDING_DEGRADED,
      window: 'PT1H', attempts: decision.attempts, lost: decision.lost, confirmed: count('confirmed'), expired: count('expired'),
      failed: count('failed'), verificationFailed: count('verification_failed'), successRate: decision.successRate })])
  return { ...decision, alerted: rowCount === 1 }
}

const percentile = (sorted, p) => sorted.length ? sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)] : null

export async function tradeOutcomeSummary(db) {
  const [raw, terminal, confirms, failures] = await Promise.all([
    db.query(`select outcome, count(*)::int as count from trade_outcomes where created_at > now() - interval '${SUMMARY_WINDOW}' group by outcome`),
    db.query(`select terminal, count(*)::int as count from (${TERMINAL_PER_ATTEMPT}) t where terminal is not null group by terminal`,
      [new Date(Date.now() - 24 * ALERT_WINDOW_MS)]),
    db.query(`select sign_to_confirm_ms as ms from trade_outcomes where outcome='confirmed' and sign_to_confirm_ms is not null
      and created_at > now() - interval '${SUMMARY_WINDOW}' order by sign_to_confirm_ms limit 5000`),
    db.query(`select outcome, mint, phase, direction, signature, error, priority_fee_lamports::text as "priorityFeeLamports", created_at as "createdAt"
      from trade_outcomes where outcome in ('expired','failed','verification_failed') order by created_at desc limit 10`),
  ])
  const counts = Object.fromEntries(TRADE_OUTCOMES.map(kind => [kind, raw.rows.find(row => row.outcome === kind)?.count ?? 0]))
  const settled = Object.fromEntries(TERMINAL_OUTCOMES.map(kind => [kind, terminal.rows.find(row => row.terminal === kind)?.count ?? 0]))
  const decision = landingAlertDecision({ confirmed: settled.confirmed, expired: settled.expired, failed: settled.failed,
    verificationFailed: settled.verification_failed })
  const times = confirms.rows.map(row => Number(row.ms))
  return { counts, settled, attempts: decision.attempts, successRate: decision.successRate,
    confirmP50Ms: percentile(times, 50), confirmP95Ms: percentile(times, 95),
    failures: failures.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })) }
}
