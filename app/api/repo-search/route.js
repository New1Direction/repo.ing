import { database } from '../../lib/server.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { repositoryCandidates } from '../../lib/repo-discovery.mjs'
import { searchList } from '../../lib/trending-launches.mjs'
import { normalizeSearch } from '../../../src/repo-search.mjs'
import { createRepoSearch, readSearchJson } from '../../../src/jev-repo-search.mjs'
import { TREND_FRESH_MS } from '../../../src/trend-rules.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const search = createRepoSearch()
let active = 0
// The list matches /find-repos: no do-not-promote repos, and "Launch" only where the trending-launch policy allows it.
export async function GET() {
  try { return Response.json({ candidates: await searchList(await repositoryCandidates(database())) }, { headers }) }
  catch { return Response.json({ error: 'Repositories are temporarily unavailable. Please try again.' }, { status: 503, headers }) }
}
export async function POST(request) {
  if (request.headers.get('origin') !== publicOrigin(request.url)) return Response.json({ error: 'Open search on repo.ing.' }, { status: 403, headers })
  if (active >= 4) return Response.json({ error: 'Search is busy. Please try again shortly.' }, { status: 429, headers })
  active++
  try {
    let query
    try { query = normalizeSearch((await readSearchJson(request)).query) }
    catch { return Response.json({ error: 'Enter a search of up to 180 characters.' }, { status: 400, headers }) }
    const candidates = await repositoryCandidates(database())
    const result = await search(query, candidates)
    // A provider call must not keep an observation alive past its expiry.
    const fresh = candidates.filter(c => Date.now() - Date.parse(c.observedAt) <= TREND_FRESH_MS)
    return Response.json({ ...result, query, candidates: await searchList(fresh), searched: fresh.length }, { headers })
  } catch { return Response.json({ error: 'Search is temporarily unavailable. Please try again.' }, { status: 503, headers }) }
  finally { active-- }
}
