import { activeOptOutRepoIds } from '../../src/maintainer-opt-outs.mjs'
import { isHfModelPath } from '../../src/hf-url.mjs'

// Repositories repo.ing must never promote: hidden from /waiting (no "Tag them on X"), and to be skipped by
// any feature that features or announces markets. Set as GitHub repository IDs, comma-separated, in
// PROMOTION_EXCLUDED_REPO_IDS (web and worker). Their markets and builder fees are unaffected.
export function promotionExcludedRepoIds(env = process.env) {
  return new Set(String(env.PROMOTION_EXCLUDED_REPO_IDS ?? '')
    .split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id)))
}

export const isPromotionExcluded = (repoId, excluded = promotionExcludedRepoIds()) => excluded.has(String(repoId))

// Hugging Face models in the same list: "hf:<model _id>" (24 hex characters, the stable identity) or "hf:<owner>/<name>".
// They have no number of their own until repo.ing registers them, so each read of the do-not-promote set resolves them to
// their registry market ids (hf_models.market_ref). A path names whichever registered model was last confirmed at that
// path; an _id always names the same model. A model repo.ing has not registered yet has no market to promote.
export function promotionExcludedModels(env = process.env) {
  const ids = new Set(), paths = new Set()
  for (const entry of String(env.PROMOTION_EXCLUDED_REPO_IDS ?? '').split(',').map(value => value.trim())) {
    const value = /^hf:(.+)$/i.exec(entry)?.[1]
    if (!value) continue
    if (/^[0-9a-f]{24}$/.test(value)) ids.add(value)
    else if (isHfModelPath(value)) paths.add(value.toLowerCase())
  }
  return { ids: [...ids], paths: [...paths] }
}

// The registry market ids of those models. No query without any; a database the 0049 migration has not reached (no
// hf_models table, 42P01) has none registered.
export async function excludedModelMarketIds(pool, { ids, paths }) {
  if (!pool || (!ids.length && !paths.length)) return []
  try {
    const { rows } = await pool.query(`select market_ref::text as "repoId" from hf_models
      where hf_id::text = any($1::text[]) or lower(repo_path) = any($2::text[])`, [ids, paths])
    return rows.map(row => row.repoId)
  } catch (error) { if (error?.code === '42P01') return []; throw error }
}

// The whole do-not-promote set: the operator's list above plus every repository whose maintainer declined its market or
// opted it out (maintainer_opt_outs, src/maintainer-opt-outs.mjs). Opt-outs are read at most once per OPT_OUTS_TTL_MS;
// the env list on every call. A failed read keeps the last good opt-outs for up to OPT_OUTS_STALE_MS after they were read;
// past that, or with none yet, it rejects, and the caller hides its promotion surface rather than risk promoting a
// repository whose maintainer said no. After a failure nothing is re-read for OPT_OUTS_RETRY_MS, so a database blip is not
// retried (and logged) by every request. Without a database there are no opt-outs.
export const OPT_OUTS_TTL_MS = 30_000
export const OPT_OUTS_STALE_MS = 10 * 60_000
export const OPT_OUTS_RETRY_MS = 5_000

export function createPromotionExclusions({ pool, env = process.env, read = activeOptOutRepoIds, resolveModels = excludedModelMarketIds,
  now = Date.now, ttlMs = OPT_OUTS_TTL_MS, staleMs = OPT_OUTS_STALE_MS, retryMs = OPT_OUTS_RETRY_MS } = {}) {
  // optOuts/readAt: the last good read. expiresAt: when to read again. retryAt/failure: the backoff after a failed read.
  let optOuts = null, readAt = 0, expiresAt = 0, retryAt = 0, failure = null, pending = null
  const usable = () => optOuts !== null && now() - readAt < staleMs
  const unavailable = () => new Error('Maintainer opt-outs are unavailable', { cause: failure })
  // One read at a time, shared by concurrent callers; a failure is logged once and starts the backoff. The env list's
  // Hugging Face models are resolved in the same read, with the same caching and the same fail-closed fallback.
  const readNow = () => Promise.resolve()
    .then(() => Promise.all([read(pool), resolveModels(pool, promotionExcludedModels(env))]))
    .then(([ids, models]) => [...ids, ...models])
    .then(list => {
      optOuts = list; readAt = now(); expiresAt = readAt + ttlMs
    }, error => {
      failure = error; retryAt = now() + retryMs
      console.warn('maintainer_opt_outs_unavailable', { code: error?.code ?? error?.name ?? 'error', usingLastGood: usable() })
      throw error
    }).finally(() => { pending = null })
  async function promotionExcluded() {
    if (pool && now() >= expiresAt) {
      if (now() < retryAt) { if (!usable()) throw unavailable() }
      else {
        pending ??= readNow()
        try { await pending } catch { if (!usable()) throw unavailable() }
      }
    }
    return new Set([...promotionExcludedRepoIds(env), ...optOuts ?? []])
  }
  // The next call reads again; until that read succeeds the last good list stays the fallback.
  promotionExcluded.refresh = () => { expiresAt = 0; retryAt = 0 }
  return promotionExcluded
}

// One cached loader per pool, so every promotion surface in a process shares the read (pages and routes can load separate
// module copies, hence globalThis).
const loaders = globalThis.__repoingPromotionExclusions ??= new WeakMap()
export function promotionExclusions(pool) {
  if (!pool) return Promise.resolve(promotionExcludedRepoIds())
  if (!loaders.has(pool)) loaders.set(pool, createPromotionExclusions({ pool }))
  return loaders.get(pool)()
}
// After a maintainer decision this process re-reads on its next call; other processes catch up within OPT_OUTS_TTL_MS.
export const forgetPromotionExclusions = pool => { if (pool) loaders.get(pool)?.refresh() }
