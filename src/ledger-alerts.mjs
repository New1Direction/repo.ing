import { createReconcileEpisodes, RECONCILE_HOLD_MS } from './reconcile.mjs'
import { feeLedgerAlertDetail, ledgerChecksAlertDetail, marketPassAlertDetail, platformLedgerAlertDetail } from './reserve-alerts.mjs'

// How many passes in a row may fail to reach a ledger before its episode is over: the passes died before they got to it, or
// another worker held it, and what it did meanwhile is unknown.
export const LEDGER_MISSED_PASSES = 2
const MATCH = Object.freeze({ status: 'MATCH' })

// The operator alerts of the graduation monitor's checks. Each thing it watches is an episode (src/reconcile.mjs
// createReconcileEpisodes): it is recorded once what a pass found has lasted its hold. What is recorded is not sent by
// itself: the delivery job gathers the recorded rows into one message (src/ledger-digest.mjs).
// feed: where a ledger's rows go. record(key, detail) stores an alert unless one with that key exists, and resolves to the
// stored row or null. clear(ledger, at) marks every row recorded for that ledger as cleared: it matched again.
// onFault(error): a row could not be stored or marked. Alert bookkeeping never fails the pass that did the checking: the
// same row is stored, or marked, by the next pass that finds the same thing.
export function createLedgerAlerts({ now = Date.now, holdMs = RECONCILE_HOLD_MS, episodes = createReconcileEpisodes({ now, holdMs }), onFault = () => {} } = {}) {
  let pass = 0
  // The pass that last settled each ledger, and the ledgers known to have no uncleared row. A ledger is not known clean
  // until this process has marked it once: rows from before a restart are cleared by the first pass that finds it matching.
  const settledIn = new Map(), clean = new Set()
  // One ledger in one pass. A match ends its episode and clears what was recorded for it; anything else is recorded once it
  // is due. name: the ledger as its rows call it.
  async function settle(feed, ledger, name, result, detail) {
    if (settledIn.has(ledger) && pass - settledIn.get(ledger) - 1 > LEDGER_MISSED_PASSES) episodes.forget(ledger)
    settledIn.set(ledger, pass)
    const episode = episodes.settle(ledger, result)
    try {
      if (result.status === 'MATCH') {
        if (!clean.has(ledger)) { await feed.clear(name, new Date(now()).toISOString()); clean.add(ledger) }
        return null
      }
      if (!episode) return null
      clean.delete(ledger)
      return await feed.record(`${name}:${episode.key}`, detail(episode))
    } catch (error) { onFault(error); return null }
  }
  return {
    // A monitor pass starts.
    beginPass() { pass += 1 },
    // One market in a pass.
    market(feed, market) {
      const id = String(market.githubRepoId)
      return {
        // Its fee ledger, as soon as the reconciliation has read it.
        settle: (result, observedAt = null) => settle(feed, `fees:${id}`, 'fees', result, episode =>
          feeLedgerAlertDetail({ market, reconciliation: result, episode, observedAt: observedAt ?? new Date(now()).toISOString(), now: now() })),
        // Its pass as a whole: verified, or ended in review with a code. A pass that keeps failing leaves the market's public
        // progress unrefreshed, whichever step fails; transient only words the alert.
        verified: () => settle(feed, `market:${id}`, 'market', MATCH),
        failed: (code, transient) => settle(feed, `market:${id}`, 'market', { status: 'UNAVAILABLE', reason: code }, episode =>
          marketPassAlertDetail({ market, code, transient, episode, now: now() })),
      }
    },
    // Whether the pass got through its markets. code: why not, or null when it did.
    checks: (feed, code) => settle(feed, 'checks', 'checks', code ? { status: 'UNAVAILABLE', reason: code } : MATCH, episode => ledgerChecksAlertDetail({ code, episode, now: now() })),
    // The platform's revenue and liquidity ledgers.
    platform: (feed, { revenue, liquidity }) => settle(feed, 'platform', 'platform', revenue.status === 'MATCH' && liquidity.status === 'MATCH' ? MATCH : { status: 'MISMATCH' },
      episode => platformLedgerAlertDetail({ revenue, liquidity, episode, now: now() })),
  }
}
