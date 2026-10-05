import { createReconcileEpisodes, RECONCILE_HOLD_MS, RECONCILE_STALE_MS } from './reconcile.mjs'
import { feeLedgerAlertDetail, ledgerChecksAlertDetail, marketPassAlertDetail, platformLedgerAlertDetail } from './reserve-alerts.mjs'

// Rows remembered for one ledger's open episode, the newest kept.
const REMEMBERED_ROWS = 40
const MATCH = Object.freeze({ status: 'MATCH' })

// The operator alerts of the graduation monitor's checks. Each thing it watches is an episode (src/reconcile.mjs
// createReconcileEpisodes): it is recorded once what a pass found has lasted its hold. What is recorded is not sent by
// itself: the delivery job gathers the recorded rows into one message (src/ledger-digest.mjs).
// feed: where a ledger's rows go. record(key, detail) stores an alert unless one with that key exists, and resolves to the
// stored row or null. clear(ids, at) marks rows as cleared: the ledger matched again.
export function createLedgerAlerts({ now = Date.now, holdMs = RECONCILE_HOLD_MS, staleMs = RECONCILE_STALE_MS, episodes = null } = {}) {
  // How far apart passes ran before the one in progress. An episode nobody settled for the stale limit is over, and passes
  // that take long must not end every episode on every pass, so the limit stays above three of them. The gap that led up to
  // the pass in progress does not count: after an outage that gap is the outage itself.
  let passStarted = null, lastGap = 0, cadence = 0
  const tracker = episodes ?? createReconcileEpisodes({ now, holdMs, staleMs: () => Math.max(staleMs, 3 * cadence) })
  const recorded = new Map()
  async function clear(feed, ledger) {
    const ids = recorded.get(ledger)
    if (!ids) return null
    // Bookkeeping, never a reason to fail the pass that found the ledger matching: rows that could not be marked stay
    // remembered, and the next matching pass marks them.
    try { await feed.clear(ids, new Date(now()).toISOString()); recorded.delete(ledger) } catch { /* marked by the next matching pass */ }
    return null
  }
  // One ledger in one pass. A match ends its episode and clears what the episode recorded; anything else is recorded once
  // it is due.
  async function settle(feed, ledger, result, detail) {
    const episode = tracker.settle(ledger, result)
    if (result.status === 'MATCH') return clear(feed, ledger)
    if (!episode) return null
    const row = await feed.record(`${ledger.split(':')[0]}:${episode.key}`, detail(episode))
    if (row) recorded.set(ledger, [...(recorded.get(ledger) ?? []), row.id].slice(-REMEMBERED_ROWS))
    return row
  }
  return {
    // A monitor pass starts.
    beginPass() {
      const at = now()
      cadence = lastGap
      if (passStarted !== null) lastGap = at - passStarted
      passStarted = at
    },
    // One market in a pass.
    market(feed, market) {
      const id = String(market.githubRepoId)
      return {
        // Its fee ledger, as soon as the reconciliation has read it.
        settle: (result, observedAt = null) => settle(feed, `fees:${id}`, result, episode =>
          feeLedgerAlertDetail({ market, reconciliation: result, episode, observedAt: observedAt ?? new Date(now()).toISOString(), now: now() })),
        // Its pass as a whole: verified, or ended in review with a code. A pass that keeps failing leaves the market's public
        // progress and its ledger unchecked, whichever step fails; transient only words the alert.
        verified: () => settle(feed, `market:${id}`, MATCH),
        failed: (code, transient) => settle(feed, `market:${id}`, { status: 'UNAVAILABLE', reason: code }, episode =>
          marketPassAlertDetail({ market, code, transient, episode, now: now() })),
      }
    },
    // Whether the pass got through its markets. code: why not, or null when it did.
    checks: (feed, code) => settle(feed, 'checks', code ? { status: 'UNAVAILABLE', reason: code } : MATCH, episode => ledgerChecksAlertDetail({ code, episode, now: now() })),
    // The platform's revenue and liquidity ledgers.
    platform: (feed, { revenue, liquidity }) => settle(feed, 'platform', revenue.status === 'MATCH' && liquidity.status === 'MATCH' ? MATCH : { status: 'MISMATCH' },
      episode => platformLedgerAlertDetail({ revenue, liquidity, episode, now: now() })),
  }
}
