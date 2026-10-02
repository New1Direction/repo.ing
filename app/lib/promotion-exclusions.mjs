import { activeOptOutRepoIds } from '../../src/maintainer-opt-outs.mjs'

// Repositories repo.ing must never promote: hidden from /waiting (no "Tag them on X"), and to be skipped by
// any feature that features or announces markets. Set as GitHub repository IDs, comma-separated, in
// PROMOTION_EXCLUDED_REPO_IDS (web and worker). Their markets and builder fees are unaffected.
export function promotionExcludedRepoIds(env = process.env) {
  return new Set(String(env.PROMOTION_EXCLUDED_REPO_IDS ?? '')
    .split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id)))
}

export const isPromotionExcluded = (repoId, excluded = promotionExcludedRepoIds()) => excluded.has(String(repoId))

// The whole do-not-promote set: the operator's list above plus every repository whose maintainer declined its market or
// opted it out (maintainer_opt_outs, src/maintainer-opt-outs.mjs). Opt-outs are read at most once per OPT_OUTS_TTL_MS;
// the env list on every call. A failed read keeps the last good opt-outs for up to OPT_OUTS_STALE_MS; past that, or
// with none yet, it rejects, and the caller hides its promotion surface rather than risk promoting a repository whose
// maintainer said no. Without a database there are no opt-outs.
export const OPT_OUTS_TTL_MS = 30_000
export const OPT_OUTS_STALE_MS = 10 * 60_000

export function createPromotionExclusions({ pool, env = process.env, read = activeOptOutRepoIds, now = Date.now,
  ttlMs = OPT_OUTS_TTL_MS, staleMs = OPT_OUTS_STALE_MS } = {}) {
  let optOuts = null, readAt = 0, pending = null
  return async function promotionExcluded() {
    if (pool && !(optOuts && now() - readAt < ttlMs)) {
      try {
        pending ??= Promise.resolve().then(() => read(pool)).then(ids => { optOuts = [...ids]; readAt = now() }).finally(() => { pending = null })
        await pending
      } catch (error) {
        if (!optOuts || now() - readAt >= staleMs) throw new Error('Maintainer opt-outs are unavailable', { cause: error })
        console.warn('maintainer_opt_outs_stale', { code: error?.code ?? error?.name ?? 'error' })
      }
    }
    return new Set([...promotionExcludedRepoIds(env), ...optOuts ?? []])
  }
}

// One cached loader per pool, so every promotion surface in a process shares the read (pages and routes can load separate
// module copies, hence globalThis).
const loaders = globalThis.__repoingPromotionExclusions ??= new WeakMap()
export function promotionExclusions(pool) {
  if (!pool) return Promise.resolve(promotionExcludedRepoIds())
  if (!loaders.has(pool)) loaders.set(pool, createPromotionExclusions({ pool }))
  return loaders.get(pool)()
}
// After a maintainer decision this process re-reads at once; other processes catch up within OPT_OUTS_TTL_MS.
export const forgetPromotionExclusions = pool => { if (pool) loaders.delete(pool) }
