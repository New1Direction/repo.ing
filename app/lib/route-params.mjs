// Cheap shape checks the proxy runs before a page starts streaming, so malformed ids get a real 404.
export const isMintAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
export const isRepoId = value => typeof value === 'string' && /^\d{1,20}$/.test(value)

export function malformedRouteId(pathname) {
  const [, section, id, ...rest] = pathname.split('/')
  if (rest.length || !id) return false
  if (section === 'token') return !isMintAddress(id)
  if (section === 'claim' || section === 'launch') return !isRepoId(id)
  return false
}
