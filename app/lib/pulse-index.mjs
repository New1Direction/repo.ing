import { database } from './server.mjs'
import { ttlMemo } from './ttl-memo.mjs'
import { loadPulseIndex } from './dev-pulse.mjs'

// Shared by Explore, the home market lists, the graduation race and the home leaders: one aggregate per 30 seconds per
// web process. A failed read shows no badges rather than failing the page.
export const pulseIndex = ttlMemo(() => loadPulseIndex(database()).catch(error => {
  console.error('dev-pulse index failed', error.message)
  return new Map()
}), 30_000)

export async function withPulse(markets) {
  const index = await pulseIndex()
  return markets.map(market => ({ ...market, pulse: index.get(String(market.repoId)) ?? null }))
}
