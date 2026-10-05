// One operator message for the ledgers that need review, instead of one per ledger.
//
// The graduation monitor records a ledger that has stayed unmatched or unchecked (src/ledger-alerts.mjs) with
// detail.delivery { status: 'digest', queuedAt }: it is never sent by itself. The delivery job (src/reserve-alerts.mjs
// digestLedgerAlerts) plans here which recorded rows go into the next message, and when:
// - A message waits until its newest row is settleMs old, so the rows of one fault that cross their holds on neighbouring
//   passes go out together, and never longer than maxWaitMs past its oldest row.
// - Messages are at least spacingMs apart, whatever the ledgers do. A provider that fails on and off records the same
//   ledgers again and again; the next message covers everything recorded since the last one.
// - A row older than maxAgeMs is expired instead: it stopped being news while the job was not running.
// The plan is made from stored rows alone. A run that fails loses nothing: the next run plans the same rows again.

export const DIGEST_SETTLE_MS = 3 * 60_000
export const DIGEST_MAX_WAIT_MS = 10 * 60_000
export const DIGEST_SPACING_MS = 60 * 60_000
// Ledgers a message names; the rest are counted. Keeps the text inside every receiver's limit (Discord: 2,000 characters).
export const DIGEST_NAMED = 10

// A recorded ledger waiting for its message. The delivery job adds `digest`, the id of the message that covered it.
export const digestDelivery = now => ({ status: 'digest', queuedAt: new Date(now).toISOString() })

const ledgerKey = row => row.detail.ledger === 'fees' ? `fees:${row.repoId}` : String(row.detail.ledger)
// Real differences first (a ledger that does not match or cannot be reconciled), then the monitor's own checks, then what
// normally clears by itself.
const urgency = detail => detail.ledger === 'checks' ? 1 : detail.ledger === 'platform' || detail.lagging === false ? 0 : 2
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0

// rows: [{ id, repoId, detail }] not yet in a message. lastDigestAt: when the last message was written (ms), or null.
// delivery: the delivery the new message is stored with. Returns { expire: [id], digest: null | { covers: [id], detail } }.
export function planLedgerDigest({ rows, lastDigestAt = null, now, maxAgeMs, delivery, settleMs = DIGEST_SETTLE_MS, maxWaitMs = DIGEST_MAX_WAIT_MS,
  spacingMs = DIGEST_SPACING_MS, named = DIGEST_NAMED }) {
  const queued = rows.map(row => ({ row, at: Date.parse(row.detail?.delivery?.queuedAt) }))
  // A row whose time cannot be read expires with the old ones, so it never holds the others up.
  const fresh = queued.filter(({ at }) => now - at <= maxAgeMs)
  const expire = queued.filter(({ at }) => !(now - at <= maxAgeMs)).map(({ row }) => row.id)
  if (!fresh.length) return { expire, digest: null }
  const times = fresh.map(({ at }) => at)
  const settled = now - Math.max(...times) >= settleMs || now - Math.min(...times) >= maxWaitMs
  const spaced = lastDigestAt === null || !(now - lastDigestAt < spacingMs)
  if (!settled || !spaced) return { expire, digest: null }
  // One entry per ledger: the row recorded last.
  const latest = new Map()
  for (const { row } of fresh) {
    const key = ledgerKey(row)
    if (!latest.has(key) || row.id > latest.get(key).id) latest.set(key, row)
  }
  const items = [...latest.values()].sort((a, b) => urgency(a.detail) - urgency(b.detail) || order(String(a.detail.since), String(b.detail.since)) || a.id - b.id)
  const detail = { ledger: 'digest', count: items.length, rows: fresh.length,
    items: items.slice(0, named).map(({ id, detail: { delivery: _delivery, ...own } }) => ({ ...own, alert: id })),
    since: items.map(item => String(item.detail.since)).sort(order)[0], observedAt: new Date(now).toISOString(), delivery }
  return { expire, digest: { covers: fresh.map(({ row }) => row.id), detail } }
}
