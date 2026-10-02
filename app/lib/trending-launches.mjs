import { configAddress, database, discoveryRewardsEnabled } from './server.mjs'
import { ttlMemo } from './ttl-memo.mjs'
import { promotionExclusions } from './promotion-exclusions.mjs'
import { freshLaunchable, readLaunchableTrends, searchListCandidates } from '../../src/trend-launchable.mjs'

// /find-repos and /launch share one read per 45 s; the rows already carry everything the list shows.
const TRENDING_TTL_MS = 45_000
// The list is optional on both pages: stop waiting after this and render the fallback. The read keeps
// running and fills the cache for the next request.
const PAGE_WAIT_MS = 2_500
const unavailable = message => ({ repos: [], unavailable: message })
const cachedLaunchable = ttlMemo(loadLaunchable, TRENDING_TTL_MS, { keep: result => !result.unavailable })

async function loadLaunchable() {
  const pool = database()
  if (!pool) return unavailable('Trending repositories are unavailable right now.')
  try {
    // Never suggest a repository on the do-not-promote list or whose maintainer opted out of repo.ing.
    const repos = await readLaunchableTrends(pool, { config: configAddress(), discoveryEnabled: discoveryRewardsEnabled(),
      promotionExcluded: await promotionExclusions(pool) })
    return { repos, unavailable: null }
  } catch (error) {
    console.warn('trending_launches_unavailable', { code: error?.code ?? error?.name ?? 'error' })
    return unavailable('Trending repositories are temporarily unavailable.')
  }
}

export async function trendingLaunches({ wait = PAGE_WAIT_MS } = {}) {
  let timer
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve(unavailable('Trending repositories are taking longer than usual to load.')), wait)
  })
  try {
    const result = await Promise.race([cachedLaunchable(), late])
    return { ...result, repos: freshLaunchable(result.repos) }
  } finally { clearTimeout(timer) }
}

// Find repos' search list, consistent with the launch list above it (shared by the page and /api/repo-search).
export async function searchList(candidates) {
  return searchListCandidates(candidates, (await trendingLaunches()).repos, await promotionExclusions(database()))
}
