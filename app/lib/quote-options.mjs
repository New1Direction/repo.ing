import { isGithubRepoId, isMarketId } from '../../src/market-identity.mjs'
import { QUOTE_REGISTRY, quoteOptions, stockPairsLaunchable } from '../../src/quote-assets.mjs'
import { repositoryById } from './server.mjs'

// The pairs a repository can launch with (GET /api/repos/<repoId>/quote-options, and the launch page). While stock pairs
// cannot be launched (the switch is off, or the code's readiness gate is closed) and for a Hugging Face model, the answer is
// SOL alone and GitHub is not read. Otherwise the owner comes from a live GitHub read (repositoryById): when GitHub cannot
// confirm the owner id, only SOL is offered. Each answer, a miss (null) included, is kept 60 s per repository and concurrent
// requests share one read, so the endpoint spends at most one GitHub read per repository per minute and process.
const TTL_MS = 60_000
const MAX_CACHED = 2000
const cache = globalThis.__repoingQuoteOptions ??= new Map()

export async function quoteOptionsForRepo(repoId, { enabled = stockPairsLaunchable(), load = repositoryById, registry = QUOTE_REGISTRY,
  now = Date.now() } = {}) {
  if (!isMarketId(repoId)) return null
  const id = String(repoId)
  const answer = options => ({ repoId: id, registryVersion: registry.version, options })
  if (!enabled || !isGithubRepoId(id)) return answer(quoteOptions(null))
  const cached = cache.get(id)
  if (cached && cached.expiresAt > now) return cached.value
  const value = Promise.resolve().then(() => load(id)).then(repo => repo
    ? answer(quoteOptions({ repoId: id, ownerId: repo.ownerId, ownerType: repo.ownerType }, { enabled, registry })) : null)
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value)
  cache.set(id, { value, expiresAt: now + TTL_MS })
  // A failed read is not kept: the next request tries again.
  return value.catch(error => { if (cache.get(id)?.value === value) cache.delete(id); throw error })
}

export const forgetQuoteOptions = () => cache.clear()
