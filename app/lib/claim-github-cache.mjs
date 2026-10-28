// Display-only cache for the claim page's GitHub App checks (site speed, 2026-10-28). The page used to call GitHub's API
// on every view; these values only choose which install button to show. Payouts never read them: a payout re-checks GitHub
// admin access itself, at most 60 seconds old (src/builder-payouts.mjs).
import { githubAppConfigurationUrl, githubInstallationForRepository } from '../../src/github-app-auth.mjs'

export const INSTALLED_TTL_MS = 120_000
export const MISSING_TTL_MS = 30_000
export const SETTINGS_URL_TTL_MS = 600_000
const MAX_ENTRIES = 2000
const store = new Map()

function remember(key, ttlMs, load, now) {
  const hit = store.get(key)
  if (hit && now() < hit.expiresAt) return hit.value
  const value = Promise.resolve().then(load)
  store.set(key, { value, expiresAt: now() + ttlMs })
  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value)
  // A failed check is not remembered; a missing one only briefly, so installing the app shows up quickly.
  value.then(result => { if (result === 'missing') store.set(key, { value, expiresAt: now() + MISSING_TTL_MS }) }, () => store.delete(key))
  return value
}

// 'installed' | 'missing'; rejects when GitHub can't be asked (the page shows 'unknown').
export const cachedInstallationStatus = ({ owner, name }, { check = githubInstallationForRepository, now = Date.now } = {}) =>
  remember(`install:${owner.toLowerCase()}/${name.toLowerCase()}`, INSTALLED_TTL_MS, async () => (await check({ owner, name })) ? 'installed' : 'missing', now)

export const cachedAppSettingsUrl = ({ owner }, { lookup = githubAppConfigurationUrl, now = Date.now } = {}) =>
  remember(`settings:${owner.toLowerCase()}`, SETTINGS_URL_TTL_MS, () => lookup({ owner }), now)

export const clearClaimGithubCache = () => store.clear()
