import { after } from 'next/server'
import { repositoryById } from './server.mjs'

// Public display only. Authorization always resolves immutable identity and permissions afresh.
const metadata = new Map(), pending = new Map()
const TTL = 5 * 60_000
export async function refreshDisplayRepository(stored) {
  const id = String(stored.repoId), cached = metadata.get(id)
  if (cached && cached.refreshAt > Date.now()) return cached.repo
  if (!pending.has(id)) pending.set(id, (async () => {
    try {
      const repo = await repositoryById(id)
      const result = repo || cached?.repo || stored
      metadata.delete(id)
      metadata.set(id, { repo: result, refreshAt: Date.now() + (repo ? TTL : 60_000) })
      if (metadata.size > 500) metadata.delete(metadata.keys().next().value)
      return result
    } finally { pending.delete(id) }
  })())
  return pending.get(id)
}
export function displayRepository(stored) {
  const cached = metadata.get(String(stored.repoId))
  if (!cached || cached.refreshAt <= Date.now()) after(() => refreshDisplayRepository(stored))
  return cached?.repo || stored
}
