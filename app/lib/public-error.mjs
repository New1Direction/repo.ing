// Only app-authored messages reach clients; anything else (Postgres, RPC, GitHub transport)
// can carry hostnames or keyed RPC URLs, so it is logged server-side and replaced.
export function publicError(error, safe, fallback, context) {
  const message = typeof error?.message === 'string' ? error.message : ''
  if (message && (typeof safe === 'function' ? safe(error) : safe.test(message))) return message
  console.error(`${context} failed`, { error: message || String(error) })
  return fallback
}
