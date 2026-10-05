import { createReconcileEpisodes, RECONCILE_HOLD_MS } from './reconcile.mjs'
import { feeLedgerAlertDetail, ledgerChecksAlertDetail, platformLedgerAlertDetail } from './reserve-alerts.mjs'

// The operator alerts of the graduation monitor's ledger checks. Each ledger is an episode (src/reconcile.mjs
// createReconcileEpisodes): it is recorded once it has stayed unmatched, or unchecked, for its hold. What is recorded is not
// sent by itself: the delivery job gathers the recorded ledgers into one message (src/ledger-digest.mjs).
// emit(key, detail) stores an alert unless one with that key exists, and resolves to the stored row or null.
export function createLedgerAlerts({ now = Date.now, holdMs = RECONCILE_HOLD_MS, episodes = createReconcileEpisodes({ now, holdMs }) } = {}) {
  return {
    // One market's fee ledger in a pass: settle(result, observedAt) with its reconciliation, or fail(code, transient) when
    // the pass failed.
    market(emit, market) {
      let settled = false
      const settle = async (result, observedAt = null) => {
        settled = true
        const episode = episodes.settle(`fees:${market.githubRepoId}`, result)
        return episode ? emit(episode.key, feeLedgerAlertDetail({ market, reconciliation: result, episode, observedAt: observedAt ?? new Date(now()).toISOString(), now: now() })) : null
      }
      // A pass that failed before it read the ledger leaves the ledger unchecked. Once the ledger was read, the failure is
      // about something else and the ledger's own finding stands.
      const fail = async (code, transient) => settled ? null : settle({ status: transient ? 'UNAVAILABLE' : 'ERROR', reason: code })
      return { settle, fail }
    },
    // Whether the pass reached its markets at all. code: why not, or null when it did.
    async checks(emit, code) {
      const episode = episodes.settle('checks', code ? { status: 'UNAVAILABLE', reason: code } : { status: 'MATCH' })
      return episode ? emit(`checks:${episode.key}`, ledgerChecksAlertDetail({ code, episode, now: now() })) : null
    },
    // The platform's revenue and liquidity ledgers.
    async platform(emit, { revenue, liquidity }) {
      const episode = episodes.settle('platform', { status: revenue.status === 'MATCH' && liquidity.status === 'MATCH' ? 'MATCH' : 'MISMATCH' })
      return episode ? emit(`platform:${episode.key}`, platformLedgerAlertDetail({ revenue, liquidity, episode, now: now() })) : null
    },
  }
}
