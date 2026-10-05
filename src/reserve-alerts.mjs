import { assertFreshGraduation, evidenceHash, evidenceJSON } from './graduation-state.mjs'
import { GRADUATED_WITHDRAWAL_MISMATCH, PARTNER_CAPTURE_MISMATCH, POOL_IDENTITY_MISMATCH, POOL_STATE_MISSING } from './reconcile.mjs'
import { DIGEST_REMINDER_MS, digestDelivery, ledgerKey, planLedgerDigest } from './ledger-digest.mjs'
import { releaseAfterUnlock } from './database-pool.mjs'
import { ledgerAlertTitle } from '../app/lib/operator-alerts.mjs'

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
// What a ledger alert records and sends. Fixed wording only: a reason is kept when it is one of this codebase's own (the
// reconciler's constants, its claim count, a review code) and dropped otherwise, because a failed read's message can quote a
// provider's response.
const OWN_REASONS = [PARTNER_CAPTURE_MISMATCH, GRADUATED_WITHDRAWAL_MISMATCH, POOL_IDENTITY_MISMATCH, POOL_STATE_MISSING]
const ownReason = reason => OWN_REASONS.includes(reason) || /^(\d{1,6} unresolved claim intent\(s\)|[A-Z][A-Z_]{3,60})$/.test(reason ?? '') ? reason : null
// What the monitor records for a ledger that is due (src/ledger-alerts.mjs). Recorded for the next ledger message
// (src/ledger-digest.mjs), never queued to be sent by itself. kind, repeat: from the episode (src/reconcile.mjs).
const recordedLedger = (episode, now) => ({ kind: episode.kind, repeat: episode.repeat, since: episode.since, delivery: digestDelivery(now) })
// A market's fee ledger.
export const feeLedgerAlertDetail = ({ market, reconciliation, episode, observedAt, now }) => ({ ledger: 'fees', status: reconciliation.status,
  reason: ownReason(reconciliation.reason), lagging: episode.lagging, difference: reconciliation.difference == null ? null : String(reconciliation.difference),
  fullName: market.fullName, observedAt, url: `https://repo.ing/token/${market.mint}`, ...recordedLedger(episode, now) })
// A market whose pass keeps ending in review. code: the review code. transient: a read that failed, not a finding.
export const marketPassAlertDetail = ({ market, code, transient, episode, now }) => ({ ledger: 'market', status: transient ? 'UNAVAILABLE' : 'ERROR',
  reason: ownReason(code), lagging: transient, fullName: market.fullName, observedAt: new Date(now).toISOString(), url: `https://repo.ing/token/${market.mint}`,
  ...recordedLedger(episode, now) })
export const platformLedgerAlertDetail = ({ revenue, liquidity, episode, now }) => ({ ledger: 'platform', revenue: revenue.status, liquidity: liquidity.status,
  problems: [...revenue.problems ?? [], ...liquidity.problems ?? []], observedAt: new Date(now).toISOString(), ...recordedLedger(episode, now) })
// The monitor's pass does not get through its markets. code: why (a review code, or one of the monitor's own).
export const ledgerChecksAlertDetail = ({ code, episode, now }) => ({ ledger: 'checks', reason: ownReason(code), observedAt: new Date(now).toISOString(),
  ...recordedLedger(episode, now) })

// Where every recorded ledger alert is listed.
const LEDGER_ALERTS_URL = 'https://repo.ing/operations/graduation'
const DIGEST_NAME_MAX = 60
// The message for the ledgers recorded since the last one (src/ledger-digest.mjs). About one ledger, it is that ledger's own
// alert; about several, it names the first few, the ones that need an operator most, and counts the rest.
function ledgerDigestText(id, detail) {
  if (detail.count === 1 && detail.items.length === 1) return ledgerAlertText(id, detail.items[0])
  const named = detail.items.map(item => {
    const name = item.fullName?.length > DIGEST_NAME_MAX ? `${item.fullName.slice(0, DIGEST_NAME_MAX - 1)}…` : item.fullName
    return `${name ? `${name}: ` : ''}${ledgerAlertTitle(item)}`
  })
  const more = detail.count - detail.items.length
  return [`repo.ing · ${ledgerAlertTitle(detail)}`, ...named, ...(more > 0 ? [`and ${more} more`] : []), `Since: ${detail.since}`, LEDGER_ALERTS_URL, `Alert #${id}`].join('\n')
}
// A recorded ledger (src/ledger-alerts.mjs): a market's fee ledger or its pass, the platform's revenue and liquidity ledgers,
// the monitor's own checks; or the message about several of them. lagging: a state that normally clears by itself.
function ledgerAlertText(id, detail) {
  if (detail.ledger === 'digest') return ledgerDigestText(id, detail)
  const title = `repo.ing · ${ledgerAlertTitle(detail)}`
  const tail = [`Since: ${detail.since}`, `Checked: ${detail.observedAt}`, ...(detail.url ? [detail.url] : []), `Alert #${id}`]
  const code = detail.reason ? ` (${detail.reason})` : ''
  if (detail.ledger === 'platform') return [title, `Revenue: ${detail.revenue} · Liquidity: ${detail.liquidity}`, ...(detail.problems ?? []), ...tail].join('\n')
  if (detail.ledger === 'checks') return [title, detail.reason === 'PASS_TOO_SLOW'
    ? 'A pass over the markets takes longer than five minutes, so public progress expires between passes.'
    : `The monitor's pass stops before it has checked every market, so ledgers go unchecked${code}.`, ...tail].join('\n')
  if (detail.ledger === 'market') return [title, detail.fullName, `${detail.lagging ? "The monitor's reads for this market keep failing" : "The monitor's pass for this market fails"}${code}.`,
    'Its public progress is not refreshed while this lasts.', ...tail].join('\n')
  const fallback = !detail.lagging ? String(detail.difference ?? '').startsWith('-') ? 'The ledger shows more fees than the chain holds.' : 'The ledger and the chain disagree.'
    : detail.status === 'UNAVAILABLE' ? 'The on-chain read keeps failing.'
    : detail.status === 'PENDING_REVIEW' ? 'A claim has not settled or been released.'
    : 'The chain shows fees the worker has not recorded. It normally catches up within minutes, so the fee indexer may be stuck or may have missed a trade.'
  return [title, detail.fullName, detail.reason ?? fallback, ...tail].join('\n')
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

// What each receiver expects, by its host. Slack and Discord webhooks take the text. Telegram's sendMessage takes the chat
// from the destination's own query (https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat>) and the text. Any other
// HTTPS receiver gets the event as JSON. A destination that cannot work is refused here, when the worker starts.
const TELEGRAM_TEXT_MAX = 4096, DISCORD_TEXT_MAX = 2000
function receiver(url) {
  if (url.hostname === 'hooks.slack.com') return ({ text }) => ({ url, body: { text } })
  if (/(^|\.)discord(app)?\.com$/.test(url.hostname)) {
    if (!/^\/api\/webhooks\/[^/]+\/[^/]+/.test(url.pathname)) throw Error('ALERT_DESTINATION_INVALID')
    // No part of an alert may ping anyone.
    return ({ text }) => ({ url, body: { content: text.slice(0, DISCORD_TEXT_MAX), allowed_mentions: { parse: [] } } })
  }
  if (url.hostname === 'api.telegram.org') {
    const chat = url.searchParams.get('chat_id')
    if (!chat || !/^\/bot[^/]+\/sendMessage$/.test(url.pathname)) throw Error('ALERT_DESTINATION_INVALID')
    const method = new URL(url)
    method.search = ''
    return ({ text }) => ({ url: method, body: { chat_id: chat, text: text.slice(0, TELEGRAM_TEXT_MAX), link_preview_options: { is_disabled: true } } })
  }
  return ({ id, text, detail }) => {
    const { delivery: _delivery, ...movement } = detail
    const event = detail.test ? 'test' : detail.role ? 'operating_wallet_low' : detail.ledger ? 'reconciliation_mismatch' : 'reserve_moved'
    return { url, body: { event, id, text, market: movement } }
  }
}

// Why a send failed, as a fixed code: the receiver's HTTP status, a timeout, or the network. Never the receiver's answer.
const sendFailure = code => Object.assign(Error('NOTIFICATION_SEND_FAILED'), { code })
// A failure's code when it is one (an SQLSTATE, a Node error code, one of this codebase's own), never its message.
const failureCode = error => {
  const code = String(error?.code ?? error?.message ?? '')
  return /^[A-Z0-9][A-Z0-9_]{2,40}$/.test(code) ? code : 'UNKNOWN'
}

// Destination is private worker configuration, never supplied by public API input.
export function createReserveWebhookSender({ env = process.env, fetchImpl = fetch } = {}) {
  if (!env.RESERVE_ALERT_WEBHOOK_URL) return null
  const url = new URL(env.RESERVE_ALERT_WEBHOOK_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('ALERT_DESTINATION_INVALID')
  const request = receiver(url)
  return async ({ id, text, detail }) => {
    const { url: target, body } = request({ id, text, detail })
    let response
    try {
      response = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `repoing-reserve-${id}` }, body: JSON.stringify(body) })
    } catch (error) { throw sendFailure(['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'NETWORK') }
    await response.body?.cancel()
    if (!response.ok) throw sendFailure(Number.isInteger(response.status) ? `HTTP_${response.status}` : 'HTTP_ERROR')
    return { accepted: true }
  }
}

// An alert's detail as jsonb, for rows that carry a delivery only. A CASE, so PostgreSQL never casts the detail of a row
// this queue does not own: a stock ledger's row can hold text that jsonb refuses, and one such row must not stop the queue.
const DETAIL = `(case when detail like '%"delivery":%' then detail::jsonb end)`
// The kinds the delivery job sends: those written with a pending delivery. Low operating balances always are; ledgers that
// stopped matching as one message for several (digestLedgerAlerts); reserve moves only when their notifications are on
// (reserveMovePlan notify).
const DELIVERED_KINDS = `'RESERVE_MOVED','OPS_WALLET_LOW','RECONCILIATION_MISMATCH'`
const WAITING = `kind in (${DELIVERED_KINDS}) and ${DETAIL}->'delivery'->>'status' in ('pending','retry')`
// A timestamp read from an alert's detail. A value that is not one reads as null, so one malformed row never stops the queue.
const time = field => `(case when ${field} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}' then (${field})::timestamptz end)`
// How many expired alerts one run names in its result; the count is always complete.
const EXPIRED_NAMED = 20
const markDelivery = change => `update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery}',(detail::jsonb->'delivery')||'${JSON.stringify(change)}'::jsonb)::text`

// Recorded ledgers waiting for a message, oldest first; more than this many at once wait for the message after.
const DIGEST_ROWS = 500
const RECORDED_LEDGER = `kind='RECONCILIATION_MISMATCH' and ${DETAIL}->'delivery'->>'status'='digest'`

// The ledger these alerts were recorded for matched again (src/ledger-alerts.mjs): they are marked with when. One that has
// not gone out in a message yet no longer does.
export const clearLedgerAlerts = (db, ids, at) => db.query(`update graduation_alerts set detail=jsonb_set(detail::jsonb,'{clearedAt}',to_jsonb($2::text))::text
  where id=any($1::int[]) and ${RECORDED_LEDGER} and ${DETAIL}->>'clearedAt' is null`, [ids, at])

// The recorded ledgers and their messages in graduation_alerts, for digestLedgerAlerts. db: one connection; the caller
// holds the delivery lock.
export function createLedgerDigestStore(db) {
  return {
    // Recorded ledgers not yet in a message.
    async waiting() {
      const { rows } = await db.query(`select id,github_repo_id::text as "repoId",detail from graduation_alerts
        where ${RECORDED_LEDGER} and ${DETAIL}->'delivery'->>'digest' is null order by id limit ${DIGEST_ROWS}`)
      return rows.map(row => ({ ...row, detail: JSON.parse(row.detail) }))
    },
    // When the last message was written and whether it still waits to be sent, and what the messages written since `since`
    // covered.
    async recent(since) {
      const { rows: messages } = await db.query(`select id,${DETAIL}->>'observedAt' as at,${DETAIL}->'delivery'->>'status' as status from graduation_alerts
        where kind='RECONCILIATION_MISMATCH' and ${DETAIL}->>'ledger'='digest' and (${DETAIL}->>'observedAt' >= $1 or id=(select max(id) from graduation_alerts
          where kind='RECONCILIATION_MISMATCH' and ${DETAIL}->>'ledger'='digest')) order by id`, [new Date(since).toISOString()])
      const last = messages.at(-1), written = messages.filter(message => message.at >= new Date(since).toISOString()).map(message => String(message.id))
      const { rows } = written.length ? await db.query(`select github_repo_id::text as "repoId",${DETAIL}->>'ledger' as ledger,${DETAIL}->>'kind' as kind,
        (${DETAIL}->>'clearedAt') is not null as cleared from graduation_alerts
        where ${RECORDED_LEDGER} and ${DETAIL}->'delivery'->>'digest'=any($1::text[])`, [written]) : { rows: [] }
      return { lastAt: last ? Date.parse(last.at) : null, pending: ['pending', 'retry'].includes(last?.status),
        covered: rows.map(row => ({ ledger: ledgerKey({ repoId: row.repoId, detail: row }), kind: row.kind, cleared: row.cleared })) }
    },
    // One transaction: the rows that expired or were cleared first, the message, and each covered row's reference to it.
    async commit({ expire, drop, digest }) {
      await db.query('begin')
      try {
        if (expire.length) await db.query(`${markDelivery({ status: 'expired', error: 'ALERT_TOO_OLD' })} where id=any($1::int[])`, [expire])
        if (drop.length) await db.query(`${markDelivery({ status: 'off', reason: 'CLEARED' })} where id=any($1::int[])`, [drop])
        if (digest) {
          // Keyed by its first row: a row is covered once, so no second message can take the same key.
          const { rows: [stored] } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,null,'RECONCILIATION_MISMATCH',$2)
            on conflict(event_key) do nothing returning id`, [`protocol:RECONCILIATION_MISMATCH:digest:${digest.covers[0]}`, evidenceJSON(digest.detail)])
          if (!stored) throw Error('LEDGER_DIGEST_CONFLICT')
          await db.query(`update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery,digest}',to_jsonb($2::int))::text where id=any($1::int[])`,
            [digest.covers, stored.id])
        }
        await db.query('commit')
      } catch (error) { await db.query('rollback'); throw error }
    },
  }
}

// Plans the next ledger message (src/ledger-digest.mjs) from what the store holds, and has the store write it.
// deliver: whether there is a destination. Without one the message is recorded unsent, so a destination set later is not
// handed old news. Returns how many rows went into a message, expired, and were dropped as cleared.
export async function digestLedgerAlerts(store, { now, deliver }) {
  const rows = await store.waiting()
  if (!rows.length) return { digested: 0, expired: 0, cleared: 0 }
  const plan = planLedgerDigest({ rows, recent: await store.recent(now - DIGEST_REMINDER_MS), now,
    delivery: deliver ? pendingDelivery(now) : { status: 'off', reason: 'DESTINATION_REQUIRED' } })
  if (plan.expire.length || plan.drop.length || plan.digest) await store.commit(plan)
  return { digested: plan.digest?.covers.length ?? 0, expired: plan.expire.length, cleared: plan.drop.length }
}

// Runs in a row that could not plan ledger messages before the queue says so itself, and how often it says it again.
const PLANNING_FAILURES_BEFORE_NOTICE = 3
const PLANNING_NOTICE_EVERY_MS = 6 * 60 * 60_000
const planningNoticeText = (code, at) => ['repo.ing · Ledger messages cannot be written', `The alert queue could not plan them ${PLANNING_FAILURES_BEFORE_NOTICE} runs in a row (${code}).`,
  'Ledgers that need review are still listed on the operations page, and are not sent while this lasts.', `Checked: ${new Date(at).toISOString()}`, LEDGER_ALERTS_URL].join('\n')

// External sends are at-least-once: an ambiguous provider timeout can cause a
// retry with the same alert ID. Delivery metadata never changes reserve evidence.
// An alert that cannot be sent is tried again, with a pause that grows to 15 minutes, until it is too old to be news
// (MAX_DELIVERY_AGE_MS); then it expires.
// reserveMoves: whether reserve moves are sent at all (RESERVE_MOVE_NOTIFICATIONS). While they are not, a move that is
// still queued (from before the setting existed, or from while it was on) is marked off instead of being sent.
// digest: the step that gathers recorded ledgers into one message, on the job's own connection.
export function createReserveAlertDelivery({ pool, send, now = Date.now, reserveMoves = false,
  digest = (db, options) => digestLedgerAlerts(createLedgerDigestStore(db), options) }) {
  let planningFailures = 0, planningNoticeAt = null
  // Ledger messages are planned with or without a destination. Planning that fails is reported in the run's result, never
  // keeps the alerts already queued from going out, and is planned again by the next run. When it keeps failing, the queue
  // says so through the destination itself: nothing else would.
  async function planLedgers(db) {
    try {
      const planned = await digest(db, { now: now(), deliver: Boolean(send) })
      planningFailures = 0
      return planned
    } catch (error) {
      const code = failureCode(error)
      planningFailures += 1
      if (send && planningFailures >= PLANNING_FAILURES_BEFORE_NOTICE && !(planningNoticeAt !== null && now() - planningNoticeAt < PLANNING_NOTICE_EVERY_MS)) {
        const at = now()
        // The notice failing too leaves planningNoticeAt as it is, so the next failed run sends it.
        try { await send({ id: 0, text: planningNoticeText(code, at), detail: { ledger: 'queue', reason: code, observedAt: new Date(at).toISOString() } }); planningNoticeAt = at } catch { /* sent by the next failed run */ }
      }
      return { digested: 0, expired: 0, cleared: 0, failed: code }
    }
  }
  async function runOnce() {
    const db = await pool.connect()
    let locked = false
    try {
      locked = (await db.query("select pg_try_advisory_lock(hashtextextended('reserve-alert-delivery',0)) as locked")).rows[0].locked
      if (!locked) return { status: 'BUSY', sent: 0 }
      const ledgers = await planLedgers(db)
      const planning = { digested: ledgers.digested, ...(ledgers.failed ? { digestError: ledgers.failed } : {}) }
      if (!send) return { status: 'DESTINATION_REQUIRED', sent: 0, expired: ledgers.expired, ...planning }
      const { rows: silenced } = reserveMoves ? { rows: [] } : await db.query(`${markDelivery({ status: 'off', error: 'RESERVE_NOTIFICATIONS_OFF' })}
        where kind='RESERVE_MOVED' and ${DETAIL}->'delivery'->>'status' in ('pending','retry') returning id`)
      // Everything too old to send expires in one statement, so a backlog (a destination set late, a long receiver
      // outage) never holds up the alerts behind it five at a time.
      const { rows: expired } = await db.query(`${markDelivery({ status: 'expired', error: 'ALERT_TOO_OLD' })}
        where ${WAITING} and ${time(`${DETAIL}->>'observedAt'`)} < $1 returning id`, [new Date(now() - MAX_DELIVERY_AGE_MS)])
      const { rows } = await db.query(`select id,detail,created_at from graduation_alerts where ${WAITING}
        and ${time(`${DETAIL}->'delivery'->>'nextAttemptAt'`)} <= now() order by id limit 5`)
      const results = expired.map(row => row.id).sort((a, b) => a - b).slice(0, EXPIRED_NAMED).map(id => ({ id, status: 'expired' }))
      const save = (id, delivery) => db.query(`update graduation_alerts set detail=jsonb_set(detail::jsonb,'{delivery}',$2::jsonb)::text where id=$1`, [id, JSON.stringify(delivery)])
      for (const row of rows) {
        const detail = JSON.parse(row.detail), delivery = detail.delivery, at = now()
        let text
        // A row whose text cannot be made is not the receiver's failure, and trying again cannot help.
        try { text = reserveAlertText(row.id, detail) }
        catch {
          Object.assign(delivery, { status: 'failed', error: 'RENDER_FAILED' })
          await save(row.id, delivery)
          results.push({ id: row.id, status: 'failed', error: 'RENDER_FAILED' })
          continue
        }
        delivery.attempts++
        try {
          const receipt = await send({ id: row.id, text, detail })
          Object.assign(delivery, { status: 'sent', sentAt: new Date(at).toISOString(), receipt, error: null, errorCode: null })
        } catch (error) {
          Object.assign(delivery, { status: 'retry', error: 'NOTIFICATION_SEND_FAILED', errorCode: failureCode(error),
            nextAttemptAt: new Date(at + Math.min(900000, 30000 * 2 ** Math.min(delivery.attempts - 1, 10))).toISOString() })
        }
        await save(row.id, delivery)
        results.push({ id: row.id, status: delivery.status, ...(delivery.errorCode ? { error: delivery.errorCode } : {}) })
      }
      return { status: ledgers.failed || results.some(r => ['failed', 'retry'].includes(r.status)) ? 'DELIVERY_REVIEW' : 'OK', sent: results.filter(r => r.status === 'sent').length,
        expired: expired.length + ledgers.expired, silenced: silenced.length, ...planning, results }
    } finally { await releaseAfterUnlock(db, () => locked ? db.query("select pg_advisory_unlock(hashtextextended('reserve-alert-delivery',0))") : null) }
  }
  return { runOnce }
}
