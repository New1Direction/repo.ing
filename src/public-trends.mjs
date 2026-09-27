import { assertFreshTrend } from './trend-rules.mjs'

// Shared public projection. Search never receives operator notes or wallet data.
export function publicTrendCandidates(candidates, { now = Date.now(), config = process.env.DBC_CONFIG, limit = 48 } = {}) {
  return candidates.flatMap(c => {
    try { assertFreshTrend(c, now) } catch { return [] }
    if (c.state === 'rejected' || c.score.total <= 0 || !/^[1-9]\d*$/.test(c.repoId) ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.fullName)) return []
    const live = c.marketStatus === 'confirmed' && c.indexedAt && c.launchFinality === 'finalized'
    const pending = Boolean(c.marketStatus && c.marketStatus !== 'failed' && !live)
    return [{ repoId: c.repoId, fullName: c.fullName, description: c.description,
      ready: Boolean(c.ready && c.approvedConfig === config && !live && !pending), mint: live ? c.mint : null,
      marketState: live ? 'live' : pending ? 'pending' : 'unlaunched',
      revision: c.revision, observedAt: c.observedAt, score: c.score,
      stars: c.latestObservation?.stars ?? null, forks: c.latestObservation?.forks ?? null,
      signals: c.signals.filter(s => s.source !== 'manual' && Date.parse(s.expiresAt) > now)
        .map(({ source, url, note, occurredAt, expiresAt }) => ({ source, url, note, occurredAt, expiresAt })) }]
  }).slice(0, limit)
}
