export function publicOrigin(requestUrl) {
  const configured = process.env.APP_ORIGIN
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('APP_ORIGIN is required in production')
  const url = new URL(configured || requestUrl)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
    throw new Error('APP_ORIGIN must be an HTTPS origin in production')
  }
  return url.origin
}
