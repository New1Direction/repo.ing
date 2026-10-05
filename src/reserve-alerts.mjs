import { assertFreshGraduation, evidenceHash, evidenceJSON } from './graduation-state.mjs'

export const RESERVE_MOVE_MIN_LAMPORTS = 50_000_000n
export const RESERVE_MOVE_COOLDOWN_MS = 5 * 60_000
const MAX_DELIVERY_AGE_MS = 6 * 60 * 60_000

function reservePoint(state) {
  const graduated = state.phase === 'GRADUATED'
  if (!['CURVE', 'GRADUATED'].includes(state.phase) || (graduated && !state.migration)) throw Error('RESERVE_PHASE_UNVERIFIED')
  const reserve = BigInt(graduated ? state.dammSolLamports : state.reserveLamports)
  if (reserve < 0n || BigInt(state.thresholdLamports) <= 0n || !state.slots?.every(Number.isSafeInteger) || state.slots.length !== 2) throw Error('RESERVE_EVIDENCE_INVALID')
  const pool = graduated ? state.destination?.pool : state.curve
  if (!pool || (graduated && pool !== state.migration.pool)) throw Error('RESERVE_POOL_MISMATCH')
  return { version: 1, repoId: state.repoId, mint: state.mint, curve: state.curve, config: state.config,
    phase: state.phase, pool, reserveLamports: String(reserve), thresholdLamports: state.thresholdLamports,
    observedAt: state.checkedAt, chainTime: state.chainTime, slots: state.slots, lastAlertAt: null }
}

// An alert waiting for the delivery job (createReserveAlertDelivery).
export const pendingDelivery = now => ({ status: 'pending', attempts: 0, nextAttemptAt: new Date(now).toISOString() })

// Compare with the last notified reserve, so small moves accumulate. A fresh
// baseline is quiet; migration starts a new DAMM baseline rather than a false sell.
// notify: also send the move to the operator destination. Off, it is recorded for the operations pages only.
export function reserveMovePlan({ market, state, previous, now = Date.now(), notify = false }) {
  assertFreshGraduation(state, now)
  const point = reservePoint(state), old = previous?.reserveAlert
  if (point.repoId !== String(market.githubRepoId) || point.mint !== market.mint || point.curve !== market.pool) throw Error('RESERVE_MARKET_MISMATCH')
  if (!old) return { baseline: point, alert: null }
  for (const key of ['version', 'repoId', 'mint', 'curve', 'config', 'thresholdLamports'])
    if (old[key] !== point[key]) throw Error('RESERVE_BINDING_MISMATCH')
  if (point.slots.some((slot, i) => slot < previous.slots[i])) throw Error('RESERVE_SLOT_REGRESSION')
  if (old.phase !== point.phase) {
    if (old.phase !== 'CURVE' || point.phase !== 'GRADUATED') throw Error('RESERVE_PHASE_REGRESSION')
    return { baseline: point, alert: null }
  }
  if (old.pool !== point.pool) throw Error('RESERVE_POOL_MISMATCH')
  const delta = BigInt(point.reserveLamports) - BigInt(old.reserveLamports)
  if ((delta < 0n ? -delta : delta) < RESERVE_MOVE_MIN_LAMPORTS ||
      (old.lastAlertAt && now - Date.parse(old.lastAlertAt) < RESERVE_MOVE_COOLDOWN_MS)) return { baseline: old, alert: null }
  const progressPercent = point.phase === 'GRADUATED' ? 100 : Math.min(100, Number(BigInt(point.reserveLamports) * 10000n / BigInt(point.thresholdLamports)) / 100)
  const detail = { repoId: point.repoId, fullName: market.fullName, mint: point.mint, pool: point.pool, phase: point.phase,
    previousReserveLamports: old.reserveLamports, reserveLamports: point.reserveLamports, deltaLamports: String(delta),
    thresholdLamports: point.thresholdLamports, progressPercent, previousObservedAt: old.observedAt,
    observedAt: point.observedAt, chainTime: point.chainTime, previousSlots: old.slots, slots: point.slots,
    url: `https://repo.ing/token/${point.mint}`,
    delivery: notify ? pendingDelivery(now) : { status: 'off' } }
  return { baseline: { ...point, lastAlertAt: new Date(now).toISOString() },
    alert: { eventKey: `${point.repoId}:RESERVE_MOVED:${evidenceHash({ old, point })}`, detail } }
}

// Uses the monitor's existing per-market lock. Checkpoint + outbox event commit
// together; a crash cannot consume a movement without recording its notification.
export async function persistGraduationObservation(db, { market, state, previous, reconciliation, enabled, notify = false, now = Date.now() }) {
  const plan = enabled ? reserveMovePlan({ market, state, previous: previous?.observation ? JSON.parse(previous.observation) : null, now, notify }) : null
  if (plan) state.reserveAlert = plan.baseline
  else if (previous?.observation) {
    const baseline = JSON.parse(previous.observation).reserveAlert
    if (baseline) state.reserveAlert = baseline
  }
  await db.query('begin')
  try {
    let alert = null
    if (plan?.alert) {
      const { rows } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail)
        values($1,$2,'RESERVE_MOVED',$3) on conflict(event_key) do nothing
        returning id,kind,github_repo_id::text as "repoId",created_at as "createdAt"`,
      [plan.alert.eventKey, state.repoId, evidenceJSON(plan.alert.detail)])
      alert = rows[0] ? { ...rows[0], detail: plan.alert.detail } : null
    }
    await db.query(`insert into graduation_observations(github_repo_id,checked_at,status,observation,reconciliation,error_code)
      values($1,now(),'VERIFIED',$2,$3,null) on conflict(github_repo_id) do update set checked_at=excluded.checked_at,status=excluded.status,
      observation=excluded.observation,reconciliation=excluded.reconciliation,error_code=null`,
    [state.repoId, evidenceJSON(state), evidenceJSON(reconciliation)])
    await db.query('commit')
    return alert
  } catch (error) { await db.query('rollback'); throw error }
}

const sol = value => {
  const amount = BigInt(value), negative = amount < 0n, n = negative ? -amount : amount
  const fraction = String(n % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${n / 1_000_000_000n}${fraction ? `.${fraction}` : ''} SOL`
}
// What a ledger alert records and sends. Fixed wording only: a failed read's own message is left out, because it can
// quote a provider's response.
export const feeLedgerAlertDetail = ({ market, reconciliation, episode, observedAt, now }) => ({ ledger: 'fees', status: reconciliation.status,
  reason: reconciliation.status === 'UNAVAILABLE' ? null : reconciliation.reason ?? null, lagging: episode.lagging, since: episode.since,
  difference: reconciliation.difference == null ? null : String(reconciliation.difference), fullName: market.fullName, observedAt,
  url: `https://repo.ing/token/${market.mint}`, delivery: pendingDelivery(now) })
export const platformLedgerAlertDetail = ({ revenue, liquidity, episode, now }) => ({ ledger: 'platform', revenue: revenue.status, liquidity: liquidity.status,
  problems: [...revenue.problems ?? [], ...liquidity.problems ?? []], since: episode.since, observedAt: new Date(now).toISOString(), delivery: pendingDelivery(now) })

// A ledger that stopped matching (src/reconcile.mjs createReconcileEpisodes): a market's fee ledger, or the platform's
// revenue and liquidity ledgers. lagging: a state that normally clears by itself and has lasted too long.
function ledgerAlertText(id, detail) {
  const tail = [`Since: ${detail.since}`, `Checked: ${detail.observedAt}`, ...(detail.url ? [detail.url] : []), `Alert #${id}`]
  if (detail.ledger === 'platform') return ['repo.ing · Platform ledger does not match',
    `Revenue: ${detail.revenue} · Liquidity: ${detail.liquidity}`, ...(detail.problems ?? []), ...tail].join('\n')
  const [title, fallback] = !detail.lagging ? ['Fee ledger does not match the chain',
    String(detail.difference ?? '').startsWith('-') ? 'The ledger shows more fees than the chain holds.' : 'The ledger and the chain disagree.']
    : detail.status === 'UNAVAILABLE' ? ['Fee ledger could not be checked', 'The on-chain read keeps failing.']
    : detail.status === 'PENDING_REVIEW' ? ['Builder claim still unresolved', 'A claim has not settled or been released.']
    : ['Fee ledger behind the chain', 'On-chain fees are still missing from the ledger. This normally clears in under a minute.']
  return [`repo.ing · ${title}`, detail.fullName, detail.reason ?? fallback, ...tail].join('\n')
}
export function reserveAlertText(id, detail) {
  if (detail.role && detail.minimumLamports) return ['repo.ing · Low operating balance',detail.role,
    `Balance: ${sol(detail.balanceLamports)}`,`Top-up threshold: ${sol(detail.minimumLamports)}`,
    `Checked: ${detail.observedAt}`,`Alert #${id}`].join('\n')
  if (detail.ledger) return ledgerAlertText(id, detail)
  return [`repo.ing · ${detail.phase === 'GRADUATED' ? 'DAMM SOL reserve' : 'Curve reserve'} ${BigInt(detail.deltaLamports) > 0n ? 'up' : 'down'}`,
    detail.fullName, `${sol(detail.previousReserveLamports)} → ${sol(detail.reserveLamports)}`,
    `Net change: ${BigInt(detail.deltaLamports) > 0n ? '+' : ''}${sol(detail.deltaLamports)}`,
    `Graduation: ${detail.phase === 'GRADUATED' ? 'GRADUATED' : `${detail.progressPercent}% of ${sol(detail.thresholdLamports)}`}`,
    `Observed: ${detail.observedAt}`, `Since: ${detail.previousObservedAt}`, detail.url, `Alert #${id}`].join('\n')
}

// Destination is private worker configuration, never supplied by public API input.
export function createReserveWebhookSender({ env = process.env, fetchImpl = fetch } = {}) {
  if (!env.RESERVE_ALERT_WEBHOOK_URL) return null
  const url = new URL(env.RESERVE_ALERT_WEBHOOK_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('ALERT_DESTINATION_INVALID')
  return async ({ id, text, detail }) => {
    const { delivery: _delivery, ...movement } = detail
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `repoing-reserve-${id}` },
      body: JSON.stringify(url.hostname === 'hooks.slack.com' ? { text }
        : { event: detail.role ? 'operating_wallet_low' : detail.ledger ? 'reconciliation_mismatch' : 'reserve_moved', id, text, market: movement }) })
    await response.body?.cancel()
    if (!response.ok) throw Error('NOTIFICATION_SEND_FAILED')
    return { accepted: true }
  }
}

// The kinds the delivery job sends: those written with a pending delivery. Low operating balances and ledgers that stopped
// matching always are; reserve moves only when their notifications are on (reserveMovePlan notify).
const DELIVERED_KINDS = `'RESERVE_MOVED','OPS_WALLET_LOW','RECONCILIATION_MISMATCH'`
const WAITING = `kind in (${DELIVERED_KINDS}) and detail::jsonb->'delivery'->>'status' in ('pending','retry')`
// How many expired alerts one run names in its result; the count is always complete.
const EXPIRED_NAMED = 20

// External sends are at-least-once: an ambiguous provider timeout can cause a
// retry with the same alert ID. Delivery metadata never changes reserve evidence.
export function createReserveAlertDelivery({ pool, send, now = Date.now }) {
  async function runOnce() {
    if (!send) return { status: 'DESTINATION_REQUIRED', sent: 0 }
    const db = await pool.connect()
    try {
      if (!(await db.query("select pg_try_advisory_lock(hashtextextended('reserve-alert-delivery',0)) as locked")).rows[0].locked) return { status: 'BUSY', sent: 0 }
      try {
        // Everything too old to send expires in one statement, so a backlog (a destination set late, a long receiver
        // outage) never holds up the alerts behind it five at a time.
        const { rows: expired } = await db.query(`update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery}',
          (detail::jsonb->'delivery')||'{"status":"expired","error":"ALERT_TOO_OLD"}'::jsonb)::text
          where ${WAITING} and (detail::jsonb->>'observedAt')::timestamptz < $1 returning id`, [new Date(now() - MAX_DELIVERY_AGE_MS)])
        const { rows } = await db.query(`select id,detail,created_at from graduation_alerts where ${WAITING}
          and (detail::jsonb->'delivery'->>'nextAttemptAt')::timestamptz <= now() order by id limit 5`)
        const results = expired.map(row => row.id).sort((a, b) => a - b).slice(0, EXPIRED_NAMED).map(id => ({ id, status: 'expired' }))
        for (const row of rows) {
          const detail = JSON.parse(row.detail), delivery = detail.delivery, time = now()
          delivery.attempts++
          try {
            const receipt = await send({ id: row.id, text: reserveAlertText(row.id, detail), detail })
            Object.assign(delivery, { status: 'sent', sentAt: new Date(time).toISOString(), receipt, error: null })
          } catch {
            Object.assign(delivery, { status: delivery.attempts >= 12 ? 'failed' : 'retry', error: 'NOTIFICATION_SEND_FAILED',
              nextAttemptAt: new Date(time + Math.min(900000, 30000 * 2 ** (delivery.attempts - 1))).toISOString() })
          }
          await db.query(`update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery}',$2::jsonb)::text where id=$1`, [row.id, JSON.stringify(delivery)])
          results.push({ id: row.id, status: delivery.status })
        }
        return { status: results.some(r => ['failed', 'retry'].includes(r.status)) ? 'DELIVERY_REVIEW' : 'OK', sent: results.filter(r => r.status === 'sent').length,
          expired: expired.length, results }
      } finally { await db.query("select pg_advisory_unlock(hashtextextended('reserve-alert-delivery',0))") }
    } finally { db.release() }
  }
  return { runOnce }
}
