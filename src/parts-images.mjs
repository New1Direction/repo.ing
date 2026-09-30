import sharp from 'sharp'
import { readLimitedBody } from './token-image.mjs'
import { UPDATE_IMAGE_REDIRECT_HOSTS, safeUpdateImageUrl } from './parts-fund.mjs'

// Build-update images are stored as GitHub/Imgur links and shown only through this re-encoder: it follows redirects
// only onto the allowed image hosts, sends no credentials or referrer, accepts raster images up to 2 MB and serves a
// fresh WebP (no SVG, metadata or animation), so a link can never inject markup or track readers.
const MAX_WIDTH = 1200
const CACHE_TTL_MS = 60 * 60_000
const CACHE_LIMIT = 100
const cache = new Map()
const options = { limitInputPixels: 24_000_000, failOn: 'error', animated: false }

function allowedHop(value) {
  let url
  try { url = new URL(value) } catch { return null }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && UPDATE_IMAGE_REDIRECT_HOSTS.has(url.hostname) ? url.href : null
}

export async function fetchUpdateImage(value, fetchImpl = fetch) {
  let url = safeUpdateImageUrl(value)
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetchImpl(url, { redirect: 'manual', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(6000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const next = allowedHop(new URL(response.headers.get('location') ?? '', url).href)
      if (!next) throw Error('Image redirect is not allowed')
      url = next
      continue
    }
    if (!response.ok) throw Error('Image could not be loaded')
    return readLimitedBody(response)
  }
  throw Error('Too many image redirects')
}

export async function renderUpdateImage(bytes) {
  const input = sharp(bytes, options).timeout({ seconds: 5 })
  const meta = await input.metadata()
  if (!['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) throw Error('Unsupported image format')
  return input.rotate().resize(MAX_WIDTH, MAX_WIDTH, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
}

export function updateImage(value, { fetchImpl = fetch, now = Date.now() } = {}) {
  const cached = cache.get(value)
  if (cached && cached.expiresAt > now) return cached.pending
  const pending = fetchUpdateImage(value, fetchImpl).then(renderUpdateImage)
  cache.delete(value)
  cache.set(value, { pending, expiresAt: now + CACHE_TTL_MS })
  pending.catch(() => { if (cache.get(value)?.pending === pending) cache.delete(value) })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return pending
}
