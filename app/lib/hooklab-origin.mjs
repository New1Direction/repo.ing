// Behind Railway's proxy the app is reached over plain HTTP, so request.url reads http://repo.ing even
// though the public origin is https://repo.ing (the rest of the site uses APP_ORIGIN for the same reason).
// The request must still have arrived for the configured host; callers keep their Origin-header and
// cross-site checks.
export function servedFromConfiguredOrigin(request, origin) {
  const configured = new URL(origin)
  const forwarded = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const host = (forwarded ?? new URL(request.url).host).split(',')[0].trim().toLowerCase()
  return host === configured.host
}
