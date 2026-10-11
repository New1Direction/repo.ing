// The repository a buyer chose to back with their AI credit packs (src/builder-pack-shares.mjs): from a token page's
// "Open a pack for owner/name" link (/credits?repo=<id>), kept 30 days in this browser; the last pick wins.
const KEY = 'repoing:backed-repo'
export const BACKED_REPO_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ID = /^[1-9]\d{0,18}$/
export function captureBackedRepo(search, storage, now = Date.now()) {
  const repo = new URLSearchParams(search).get('repo')
  if (ID.test(repo ?? '')) storage.setItem(KEY, JSON.stringify({ repo, at: now }))
}
export function storedBackedRepo(storage, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(KEY) ?? 'null')
    return value && ID.test(value.repo ?? '') && Number.isFinite(value.at) && value.at <= now && now - value.at < BACKED_REPO_TTL_MS ? value.repo : null
  } catch { return null }
}
export const clearBackedRepo = storage => storage.removeItem(KEY)
