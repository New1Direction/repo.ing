// One operator message for the ledgers that need review, instead of one per ledger.
//
// The graduation monitor records a ledger that has stayed unmatched or unchecked (src/ledger-alerts.mjs) with
// detail.delivery { status: 'digest', queuedAt }: it is never sent by itself. The delivery job (src/reserve-alerts.mjs
// digestLedgerAlerts) plans here which recorded rows go into the next message, and when:
// - News is a ledger, with a kind of trouble, that no message has told the operator about. A message with news waits
//   until its newest news is settleMs old, so the rows of one fault that cross their holds on neighbouring passes go out
//   together, and never longer than maxWaitMs past its oldest. Messages are at least spacingMs apart.
// - Everything else is a reminder: a repeat of an episode already announced, or the same kind of trouble recorded again
//   for a ledger that a message covered in the last reminderMs (a provider that fails on and off, a worker that
//   restarted). Reminders ride along with news, and by themselves go out once per reminderMs.
//   A real difference that was cleared and came back is news again.
// - One message at a time: while the last one is still waiting to be sent, nothing new is written.
// - A ledger that matched again before its row went out is dropped, and a row older than maxAgeMs is expired.
// The plan is made from stored rows alone. A run that fails loses nothing: the next run plans the same rows again.

export const DIGEST_SETTLE_MS = 3 * 60_000
export const DIGEST_MAX_WAIT_MS = 10 * 60_000
export const DIGEST_SPACING_MS = 60 * 60_000
export const DIGEST_REMINDER_MS = 6 * 60 * 60_000
// Above the reminder period, so a reminder that waited its turn is still sent.
export const DIGEST_ROW_MAX_AGE_MS = 8 * 60 * 60_000
// Ledgers a message names; the rest are counted. Keeps the text inside every receiver's limit (Discord: 2,000 characters).
export const DIGEST_NAMED = 10

// A recorded ledger waiting for its message. The delivery job adds `digest`, the id of the message that covered it.
export const digestDelivery = now => ({ status: 'digest', queuedAt: new Date(now).toISOString() })

// Which ledger a recorded row is about: a market's fee ledger, a market's pass, the platform ledgers or the monitor's checks.
export const ledgerKey = ({ repoId, detail }) => ['fees', 'market'].includes(detail.ledger) ? `${detail.ledger}:${repoId}` : String(detail.ledger)
// Real differences first (a ledger that does not match, a pass that fails for good), then the monitor's own checks, then what
// normally clears by itself.
const urgency = detail => detail.ledger === 'checks' ? 1 : detail.ledger === 'platform' || detail.lagging === false ? 0 : 2
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0

// rows: [{ id, repoId, detail }] not yet in a message.
// recent: { lastAt, pending, covered }: when the last message was written (ms, or null), whether it is still waiting to be
//   sent, and the rows that messages covered in the last reminderMs as [{ ledger, kind, cleared }].
// delivery: the delivery the new message is stored with.
// Returns { expire: [id], drop: [id], digest: null | { covers: [id], detail } }.
export function planLedgerDigest({ rows, recent = {}, now, delivery, maxAgeMs = DIGEST_ROW_MAX_AGE_MS, settleMs = DIGEST_SETTLE_MS, maxWaitMs = DIGEST_MAX_WAIT_MS,
  spacingMs = DIGEST_SPACING_MS, reminderMs = DIGEST_REMINDER_MS, named = DIGEST_NAMED }) {
  const { lastAt = null, pending = false, covered = [] } = recent
  const queued = rows.map(row => ({ row, at: Date.parse(row.detail?.delivery?.queuedAt) }))
  // A row whose time cannot be read expires with the old ones, so it never holds the others up.
  const expire = queued.filter(({ at }) => !(now - at <= maxAgeMs)).map(({ row }) => row.id)
  const live = queued.filter(({ at }) => now - at <= maxAgeMs)
  const drop = live.filter(({ row }) => row.detail.clearedAt).map(({ row }) => row.id)
  const fresh = live.filter(({ row }) => !row.detail.clearedAt)
  if (!fresh.length) return { expire, drop, digest: null }
  const told = new Set(covered.map(row => `${row.ledger}|${row.kind}`)), open = new Set(covered.filter(row => !row.cleared).map(row => `${row.ledger}|${row.kind}`))
  const reminder = row => row.detail.repeat === true || (row.detail.kind === 'difference' ? open : told).has(`${ledgerKey(row)}|${row.detail.kind}`)
  const news = fresh.filter(({ row }) => !reminder(row))
  const times = (news.length ? news : fresh).map(({ at }) => at)
  const settled = now - Math.max(...times) >= settleMs || now - Math.min(...times) >= maxWaitMs
  const spaced = lastAt === null || !(now - lastAt < (news.length ? spacingMs : reminderMs))
  if (pending || !settled || !spaced) return { expire, drop, digest: null }
  // One entry per ledger: its most urgent row, and of those the one recorded last.
  const chosen = new Map()
  for (const { row } of fresh) {
    const key = ledgerKey(row), known = chosen.get(key)
    if (!known || urgency(row.detail) < urgency(known.detail) || (urgency(row.detail) === urgency(known.detail) && row.id > known.id)) chosen.set(key, row)
  }
  const items = [...chosen.values()].sort((a, b) => urgency(a.detail) - urgency(b.detail) || order(String(a.detail.since), String(b.detail.since)) || a.id - b.id)
  const detail = { ledger: 'digest', count: items.length, rows: fresh.length, reminder: news.length === 0,
    items: items.slice(0, named).map(({ id, detail: { delivery: _delivery, ...own } }) => ({ ...own, alert: id })),
    since: items.map(item => String(item.detail.since)).sort(order)[0], observedAt: new Date(now).toISOString(), delivery }
  return { expire, drop, digest: { covers: fresh.map(({ row }) => row.id), detail } }
}
