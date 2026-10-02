import { growthSurface } from '../../src/discoverer-growth.mjs'
import { database } from './server.mjs'
import { ttlMemo } from './ttl-memo.mjs'
import { timed } from './server-timing.mjs'
import { promotionExclusions } from './promotion-exclusions.mjs'

// /explore's highlights and every open Explore tab's once-a-minute /api/growth refresh share one public growth read per
// 15 s per process (the page and the route can load separate module copies, hence globalThis). The operator view still
// reads fresh. A failed read is not kept, so the next request retries. The highlights never list a do-not-promote or
// maintainer-declined repository; without that list they fail instead.
export const GROWTH_TTL_MS = 15_000
export const publicGrowth = globalThis.__repoingPublicGrowth ??= ttlMemo(() => timed('growthSurface', async () =>
  growthSurface(database(), { excluded: await promotionExclusions(database()) })), GROWTH_TTL_MS)
