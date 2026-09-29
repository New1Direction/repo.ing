import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { safeGithubImageUrl } from './repo-logo.mjs'

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_SAVED_IMAGE_BYTES = 384 * 1024
const PNG_PREFIX = 'data:image/png;base64,'
const options = { limitInputPixels: 16_000_000, failOn: 'error', animated: false }
const pngOptions = { compressionLevel: 9, palette: true, colours: 256 }

export async function readLimitedBody(response, limit = MAX_IMAGE_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) throw Error('Image is too large. Maximum size is 2 MB.')
  if (!response.body) throw Error('Image is empty')
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel(); throw Error('Image is too large. Maximum size is 2 MB.') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}

// Never follow an image-host redirect onto an arbitrary host or send GitHub credentials.
export async function fetchGithubImage(value, fetchImpl = fetch) {
  let url = value
  for (let attempt = 0; attempt < 4; attempt++) {
    url = safeGithubImageUrl(url)
    if (!url) throw Error('Unsupported image source')
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const next = response.headers.get('location')
      if (!next) throw Error('Image redirect is unavailable')
      url = new URL(next, url).href
      continue
    }
    if (!response.ok) throw Error('Image could not be loaded')
    return readLimitedBody(response)
  }
  throw Error('Too many image redirects')
}

const isRasterImage = bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
  (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
  /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')) ||
  (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')

export async function normalizeTokenImage(bytes, { allowSvg = false } = {}) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Error('Choose an image up to 2 MB.')
  if (!isRasterImage(bytes)) {
    const svg = bytes.toString('utf8')
    if (!allowSvg || !/<svg\b/i.test(svg)) throw Error('This image could not be read. Choose PNG, JPEG, WebP, or GIF.')
    // Check before invoking the SVG decoder, including its metadata parser.
    if (/<!DOCTYPE|<!ENTITY|<script|<foreignObject|@import/i.test(svg) ||
      /(?:href|src)\s*=\s*["'](?!#)/i.test(svg) || /url\(\s*["']?(?!#)[^)]/i.test(svg)) throw Error('SVG references are not supported')
  }
  const input = sharp(bytes, options).timeout({ seconds: 5 })
  let meta
  try { meta = await input.metadata() } catch { throw Error('This image could not be read. Try PNG, JPEG, or WebP.') }
  if (!['png', 'jpeg', 'webp', 'gif', ...(allowSvg ? ['svg'] : [])].includes(meta.format)) throw Error('Choose a PNG, JPEG, WebP, or GIF image.')
  if (meta.width < 32 || meta.height < 32 || meta.width * meta.height > options.limitInputPixels) throw Error('Choose an image at least 32 × 32 pixels and no larger than 16 megapixels.')
  // Choose a stable contrasting canvas for transparent dark/white logo variants.
  const { data } = await input.clone().rotate().resize(32, 32, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let weight = 0, light = 0
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255
    weight += alpha
    light += alpha * (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
  }
  if (!weight) throw Error('This image is fully transparent. Choose a visible image.')
  const background = light / weight > 175 ? '#161b22' : '#ffffff'
  const png = await input.rotate().resize(512, 512, { fit: 'contain', background }).flatten({ background }).png(pngOptions).toBuffer()
  if (png.length > MAX_SAVED_IMAGE_BYTES) throw Error('This image is too detailed. Try a simpler logo.')
  return { image: `${PNG_PREFIX}${png.toString('base64')}`, width: meta.width, height: meta.height }
}

export function tokenImageBytes(value) {
  if (typeof value !== 'string' || value.length > PNG_PREFIX.length + Math.ceil(MAX_SAVED_IMAGE_BYTES / 3) * 4 ||
      !value.startsWith(PNG_PREFIX)) throw Error('Choose a token image before reviewing the launch.')
  const encoded = value.slice(PNG_PREFIX.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_SAVED_IMAGE_BYTES || bytes.toString('base64') !== encoded ||
      !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Invalid token image')
  return bytes
}

// Re-decode untrusted launch input and strip ancillary data, without resizing the reviewed artwork.
export async function validateTokenImage(value) {
  const bytes = tokenImageBytes(value)
  const input = sharp(bytes, options).timeout({ seconds: 5 })
  const meta = await input.metadata()
  if (meta.format !== 'png' || meta.width !== 512 || meta.height !== 512 || (meta.pages ?? 1) !== 1) throw Error('Token image must use the prepared square preview')
  const png = await input.png(pngOptions).toBuffer()
  if (png.length > MAX_SAVED_IMAGE_BYTES) throw Error('Token image is too large')
  return `${PNG_PREFIX}${png.toString('base64')}`
}

// Small WebP renditions for in-app avatars; the 512px PNG stays canonical for on-chain metadata.
export const TOKEN_IMAGE_WIDTHS = [64, 128, 256]
const VARIANT_CACHE_LIMIT = 500
const variants = new Map()

async function tokenImageVariant(bytes, digest, width) {
  const key = `${digest}:${width}`
  let pending = variants.get(key)
  if (!pending) {
    pending = sharp(bytes, options).timeout({ seconds: 5 }).resize(width, width).webp({ quality: 82 }).toBuffer()
    variants.set(key, pending)
    pending.catch(() => variants.delete(key))
    if (variants.size > VARIANT_CACHE_LIMIT) variants.delete(variants.keys().next().value)
  }
  return pending
}

export async function tokenImageResponse(value, width = null) {
  const bytes = tokenImageBytes(value)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const variant = TOKEN_IMAGE_WIDTHS.includes(width)
  const body = variant ? await tokenImageVariant(bytes, digest, width) : bytes
  return new Response(body, { headers: { 'Content-Type': variant ? 'image/webp' : 'image/png', 'Content-Length': String(body.length),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    ETag: `"${digest}${variant ? `-w${width}` : ''}"` } })
}

// Resized WebP of a remote GitHub logo. Repository logos can change, so entries expire.
const GITHUB_VARIANT_TTL_MS = 60 * 60_000
const githubVariants = new Map()

export function imageWidthParam(value) {
  if (value === null || value === undefined) return null
  const width = Number(value)
  return TOKEN_IMAGE_WIDTHS.includes(width) && String(width) === value ? width : undefined
}

async function renderGithubImage(value, width, fetchImpl) {
  const url = new URL(value)
  if (url.hostname === 'avatars.githubusercontent.com') url.searchParams.set('s', String(width))
  const bytes = await fetchGithubImage(url.href, fetchImpl)
  // SVG is never decoded here: README SVGs are untrusted and the caller falls back to a redirect.
  if (!isRasterImage(bytes)) throw Error('Unsupported image format')
  return sharp(bytes, options).timeout({ seconds: 5 }).resize(width, width, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
}

export async function githubImageVariant(value, width, { fetchImpl = fetch, now = Date.now() } = {}) {
  const key = `${width}:${value}`
  const cached = githubVariants.get(key)
  if (cached && cached.expiresAt > now) return cached.pending
  const pending = renderGithubImage(value, width, fetchImpl)
  githubVariants.delete(key)
  githubVariants.set(key, { pending, expiresAt: now + GITHUB_VARIANT_TTL_MS })
  pending.catch(() => { if (githubVariants.get(key)?.pending === pending) githubVariants.delete(key) })
  if (githubVariants.size > VARIANT_CACHE_LIMIT) githubVariants.delete(githubVariants.keys().next().value)
  return pending
}

export function githubImageVariantResponse(body) {
  return new Response(body, { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(body.length),
    'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } })
}
