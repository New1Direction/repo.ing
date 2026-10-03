import { isGithubRepoId, isMarketId } from '../../src/market-identity.mjs'
import { QUOTE_REGISTRY, quoteOptions, stockQuotesEnabled } from '../../src/quote-assets.mjs'
import { repositoryById } from './server.mjs'

// The pairs a repository can launch with (GET /api/repos/<repoId>/quote-options, and the launch page). With stock pairs off,
// or for a Hugging Face model, the answer is SOL alone and GitHub is not read. Otherwise the owner comes from a live GitHub
// read (repositoryById): when GitHub cannot confirm the owner id, only SOL is offered. Answers are kept 60 s per repository
// so the endpoint cannot spend the GitHub quota faster than once a minute per repository and process.
const TTL_MS = 60_000
const MAX_CACHED = 2000
const cache = globalThis.__repoingQuoteOptions ??= new Map()

export async function quoteOptionsForRepo(repoId, { enabled = stockQuotesEnabled(), load = repositoryById, registry = QUOTE_REGISTRY,
  now = Date.now() } = {}) {
  if (!isMarketId(repoId)) return null
  const id = String(repoId)
  const answer = options => ({ repoId: id, registryVersion: registry.version, options })
  if (!enabled || !isGithubRepoId(id)) return answer(quoteOptions(null))
  const cached = cache.get(id)
  if (cached && cached.expiresAt > now) return cached.value
  const repo = await load(id)
  if (!repo) return null
  const value = answer(quoteOptions({ repoId: id, ownerId: repo.ownerId, ownerType: repo.ownerType }, { enabled, registry }))
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value)
  cache.set(id, { value, expiresAt: now + TTL_MS })
  return value
}

export const forgetQuoteOptions = () => cache.clear()
