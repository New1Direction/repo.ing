// Single-flight in-process memo. Next's unstable_cache JSON-serializes results (Dates become
// strings) and is superseded by 'use cache', which needs cacheComponents; this keeps values intact.
export function ttlMemo(load, ttlMs, { keep = () => true, clock = Date.now } = {}) {
  let value, expiresAt = 0, pending = null
  return () => {
    if (pending) return pending
    if (clock() < expiresAt) return Promise.resolve(value)
    pending = load().then(result => {
      if (keep(result)) { value = result; expiresAt = clock() + ttlMs }
      return result
    }).finally(() => { pending = null })
    return pending
  }
}
