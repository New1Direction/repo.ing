import { createReconcileEpisodes, RECONCILE_HOLD_MS } from './reconcile.mjs'
import { feeLedgerAlertDetail, ledgerChecksAlertDetail, ledgerSummaryAlertDetail, platformLedgerAlertDetail } from './reserve-alerts.mjs'

// New fee-ledger alerts one monitor pass sends one by one. Past it (an outage that touches every market at once) the rest
// are recorded unsent, and one alert says how many.
export const LEDGER_PAGES_PER_PASS = 3

// The operator alerts of the graduation monitor's ledger checks, pass by pass. Each ledger is an episode
// (src/reconcile.mjs createReconcileEpisodes): it alerts once it has stayed unmatched, or unchecked, for holdMs.
// emit(key, detail) stores an alert unless one with that key exists, and resolves to the stored row or null.
export function createLedgerAlerts({ now = Date.now, holdMs = RECONCILE_HOLD_MS, pagesPerPass = LEDGER_PAGES_PER_PASS,
  episodes = createReconcileEpisodes({ now, holdMs }) } = {}) {
  function beginPass() {
    const started = now()
    let pages = 0, summarized = 0
    return {
      // One market's fee ledger in this pass: settle(result, observedAt) with its reconciliation, or fail(code, transient)
      // when the pass failed.
      market(emit, market) {
        let settled = false
        const settle = async (result, observedAt = null) => {
          settled = true
          const episode = episodes.settle(String(market.githubRepoId), result)
          if (!episode) return null
          // The place is taken before the alert is stored and given back when nothing was: a row that already exists was
          // sent, or summed up, when it was stored.
          const deliver = pages < pagesPerPass
          if (deliver) pages += 1
          const row = await emit(episode.key, feeLedgerAlertDetail({ market, reconciliation: result, episode,
            observedAt: observedAt ?? new Date(now()).toISOString(), now: now(), deliver }))
          if (!row && deliver) pages -= 1
          if (row && !deliver) summarized += 1
          return row
        }
        // A pass that failed before it read the ledger leaves the ledger unchecked. Once the ledger was read, the failure is
        // about something else and the ledger's own finding stands.
        const fail = async (code, transient) => settled ? null : settle({ status: transient ? 'UNAVAILABLE' : 'ERROR', reason: code })
        return { settle, fail }
      },
      // Whether the pass could verify the chain at all. code: why not, or null when it could.
      async checks(emit, code) {
        const episode = episodes.settle('checks', code ? { status: 'UNAVAILABLE', reason: code } : { status: 'MATCH' })
        return episode ? emit(`checks:${episode.key}`, ledgerChecksAlertDetail({ code, episode, now: now() })) : null
      },
      // The platform's revenue and liquidity ledgers.
      async platform(emit, { revenue, liquidity }) {
        const episode = episodes.settle('platform', { status: revenue.status === 'MATCH' && liquidity.status === 'MATCH' ? 'MATCH' : 'MISMATCH' })
        return episode ? emit(`platform:${episode.key}`, platformLedgerAlertDetail({ revenue, liquidity, episode, now: now() })) : null
      },
      // After the last market: one alert for everything this pass recorded unsent.
      async finish(emit) {
        return summarized ? emit(`summary:${started}`, ledgerSummaryAlertDetail({ count: summarized, now: now() })) : null
      },
    }
  }
  return { beginPass }
}
