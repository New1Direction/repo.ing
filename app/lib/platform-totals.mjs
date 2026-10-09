import { database } from './server.mjs'
import { ttlMemo } from './ttl-memo.mjs'
import { readProtocolAnalytics } from '../../src/protocol-analytics.mjs'

const TOTALS_TTL_MS = 300_000

// All-time protocol totals (volume, trades, markets…) from the same read /stats shows, at most once per five minutes per
// process, for pages that only need the headline figures. null while the database is off or the read fails; a failure is
// not kept, so the next view retries. paidOutside: the part of `paid` that went to builders outside repo.ing's own
// repositories (the /stats split, TEAM_REPO_OWNERS and TEAM_REPO_IDS in src/protocol-analytics.mjs).
export const platformTotals = globalThis.__repoingPlatformTotals ??= ttlMemo(async () => {
  const db = database()
  if (!db) return null
  try {
    const { totals, builders } = await readProtocolAnalytics(db, { range: 'all' })
    return totals ? { ...totals, paidOutside: builders?.paid?.outside ?? null } : null
  }
  catch (error) { console.error('platform totals unavailable', error?.code ?? error?.message ?? 'error'); return null }
}, TOTALS_TTL_MS, { keep: totals => totals != null })
