import { cache } from 'react'
import { database } from './server.mjs'
import { promotionExclusions } from './promotion-exclusions.mjs'
import { activeDecision } from '../../src/maintainer-opt-outs.mjs'

// Web side of maintainer opt-outs (src/maintainer-opt-outs.mjs).

// The do-not-promote set (PROMOTION_EXCLUDED_REPO_IDS plus maintainer opt-outs), or null when it cannot be read: the
// caller then hides its promotion surface (fails closed).
export async function promotionExcluded() {
  try { return await promotionExclusions(database()) }
  catch (error) { console.error('promotion exclusions unavailable', { error: error.cause?.message ?? error.message }); return null }
}

// Markets a list may promote, or null when the do-not-promote set is unavailable.
export async function promotableMarkets(markets) {
  const excluded = await promotionExcluded()
  return excluded && markets.filter(market => !excluded.has(String(market.repoId)))
}

// One repository's active decision (token page banner, claim page, launch page): null when there is none, undefined when it
// could not be read, which callers treat as "do not promote, show nothing".
export const maintainerDecision = cache(async repoId => {
  const pool = database()
  if (!pool) return null
  try { return await activeDecision(pool, repoId) }
  catch (error) { console.error('maintainer decision unavailable', { repoId: String(repoId), error: error.message }); return undefined }
})
