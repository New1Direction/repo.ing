import * as z from 'zod/v4'
import { HfUrlError, isHfModelPath, isHfName, parseHfModelUrl } from './hf-url.mjs'
export { HfUrlError, parseHfModelUrl }

// Hugging Face Hub client for model markets. docs/HUGGING_FACE_API_NOTES.md records the live behaviour it relies on.
//
//   const hf = createHfClient({ token })   // token optional; never logged or put in errors
//   await hf.model({ path })               // path: a model URL or owner/name. { hfId, path, owner: { handle }, private, disabled,
//                                          //   gated, createdAt, lastModified, sha, pipelineTag, license, likes, downloads30d,
//                                          //   downloadsAllTime, trendingScore, baseModels, childrenCount, spacesCount, redirectedFrom }
//   await hf.userOverview(name) / hf.orgOverview(name) / hf.owner(handle)   // { id, handle, kind, fullname, avatarUrl, redirectedFrom }
//   await hf.commitsCount(path)            // number; path: the canonical owner/name from model()
//   await hf.discussionsCount(path)        // { total, open, closed }; same path
//   await hf.trendingModels()              // [{ rank, path, owner, private, gated, likes, downloads30d, lastModified, pipelineTag }]
//   hf.rateLimit()                         // latest RateLimit reading, or null
//
// Invalid input throws HfUrlError before any request; everything else that is not a clean answer throws one of the Hf*Error
// classes below. A path that redirects can land on a different repository (runwayml/stable-diffusion-v1-5 now serves a repo
// created in 2024), so redirects are followed by hand and reported, and callers key on hfId, never on the path. Only
// model() and the account lookups follow them, because their responses carry an _id to check; the counting calls refuse
// to count whatever a moved path now points at. model() only returns public, enabled models; private and disabled throw.
export const HF_ORIGIN = 'https://huggingface.co'
// The Hub lists at most this many Spaces per model: a spacesCount equal to it means "this many or more".
export const HF_SPACES_CAP = 100
const MAX_BODY_BYTES = 1_000_000
const MAX_REDIRECTS = 2
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const RETRIED = new Set([429, 500, 502, 503, 504])
const MODEL_QUERY = '?' + ['author', 'private', 'disabled', 'gated', 'createdAt', 'lastModified', 'sha', 'pipeline_tag', 'tags', 'likes',
  'downloads', 'downloadsAllTime', 'trendingScore', 'baseModels', 'childrenModelCount', 'spaces'].map(field => `expand[]=${field}`).join('&')

export class HfApiError extends Error {
  constructor(message, { cause, ...details } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = new.target.name
    Object.assign(this, details)
  }
}
export class HfNotFoundError extends HfApiError {}
export class HfPrivateError extends HfApiError {}
export class HfDisabledError extends HfApiError {}
// The resource needs a token whose user accepted the model's gate (anonymous commit listings of gated models, for one).
export class HfGatedError extends HfApiError {}
// retryAt: epoch milliseconds when the window resets.
export class HfRateLimitedError extends HfApiError {}
export class HfUpstreamError extends HfApiError {}

// Hub text ends up on our pages: controls become spaces; zero-width spaces, bidi marks and overrides, tag characters,
// blank fillers and lone surrogates are dropped (ZWJ and ZWNJ stay: scripts and emoji need them); whitespace collapses
// and the result is cut to max code points.
export function cleanText(value, max) {
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]|\p{Cs}/gu, '')
    .replace(/\s+/g, ' ').trim()
  return [...text].slice(0, max).join('').trim() || null
}

// Avatars are shown and may be fetched server-side for token art, so only Hub avatar paths are kept, without their query
// strings. Gravatar's d= parameter can name any URL to redirect to, so Gravatar links are rebuilt with a built-in default.
function avatarUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) return null
  let url
  try { url = new URL(value, HF_ORIGIN) } catch { return null }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
  const { hostname: host, pathname: path } = url
  if (host === 'cdn-avatars.huggingface.co' && /^\/v1\/production\/uploads\/[\w./-]+$/.test(path)) return `https://${host}${path}`
  if (host === 'huggingface.co' && /^\/avatars\/[\w.-]+$/.test(path)) return `https://${host}${path}`
  if (host === 'www.gravatar.com' && /^\/avatar\/[0-9a-f]{32,64}$/.test(path)) return `https://${host}${path}?d=retro`
  return null
}

// `RateLimit: "api";r=498;t=246` and `RateLimit-Policy: "fixed window";"api";q=500;w=300`, as the Hub sends them.
export function parseRateLimit(headers) {
  const match = /"([\w-]{1,32})"\s*;\s*r\s*=\s*(\d{1,9})\s*;\s*t\s*=\s*(\d{1,9})/.exec(headers.get('ratelimit') ?? '')
  if (!match) return null
  const policy = /\bq\s*=\s*(\d{1,9})\s*;\s*w\s*=\s*(\d{1,9})/.exec(headers.get('ratelimit-policy') ?? '')
  return { bucket: match[1], remaining: Number(match[2]), resetSeconds: Number(match[3]),
    quota: policy ? Number(policy[1]) : null, windowSeconds: policy ? Number(policy[2]) : null }
}

function retryAfterMs(headers, now) {
  const value = headers.get('retry-after')?.trim()
  if (!value) return 0
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : 0
}

// Types are strict (a wrong type means the API changed: fail closed); lengths of free text are cut, not refused, and the
// body size cap bounds everything else.
const objectId = z.string().regex(/^[0-9a-f]{24}$/)
const modelPath = z.string().refine(isHfModelPath, 'Invalid model path')
const handle = z.string().refine(isHfName, 'Invalid handle')
const count = z.number().int().nonnegative()
const sha = z.string().regex(/^[0-9a-f]{40}$/)
const time = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString())
const label = max => z.string().transform(value => cleanText(value, max))
const keyword = z.string().regex(/^[a-z_-]{1,32}$/)
const optional = schema => schema.nullish().transform(value => value ?? null)
const gated = z.union([z.literal(false), z.enum(['auto', 'manual'])])

const modelSchema = z.object({
  _id: objectId, id: modelPath, author: handle, private: z.boolean(), disabled: z.boolean(), gated,
  createdAt: optional(time), lastModified: optional(time), sha: optional(sha), pipeline_tag: optional(label(64)),
  tags: z.array(z.string()).default([]),
  likes: optional(count), downloads: optional(count), downloadsAllTime: optional(count), trendingScore: optional(z.number()),
  baseModels: optional(z.object({ relation: keyword, models: z.array(z.object({ _id: objectId, id: modelPath })) })),
  childrenModelCount: optional(z.record(keyword, count)),
  spaces: optional(z.array(z.string())),
})
const userSchema = z.object({ _id: objectId, user: handle, type: z.literal('user'), fullname: optional(label(100)), avatarUrl: z.unknown() })
const orgSchema = z.object({ _id: objectId, name: handle, fullname: optional(label(100)), avatarUrl: z.unknown() })
const commitsSchema = z.array(z.object({ id: sha })).max(1)
const discussionsSchema = z.object({ count, numClosedDiscussions: optional(count) })
const trendingSchema = z.object({ recentlyTrending: z.array(z.object({ repoType: z.string(), repoData: z.unknown() })) })
const trendingModelSchema = z.object({
  id: modelPath, author: handle, private: z.boolean(), gated, likes: count, downloads: count,
  lastModified: optional(time), pipeline_tag: optional(label(64)),
  authorData: optional(z.object({ _id: objectId, name: handle, type: z.enum(['user', 'org']) })),
})

function validate(schema, data, what) {
  const result = schema.safeParse(data)
  if (result.success) return result.data
  const issues = result.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  throw new HfUpstreamError(`Unexpected Hugging Face ${what} response`, { code: 'HF_INVALID_RESPONSE', issues })
}

const mismatch = path => new HfUpstreamError('Hugging Face returned a different record than requested', { code: 'HF_IDENTITY_MISMATCH', path })

function transportError(error) {
  const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
  return new HfUpstreamError(timeout ? 'Hugging Face request timed out' : 'Hugging Face request failed',
    { code: timeout ? 'HF_TIMEOUT' : 'HF_NETWORK', cause: error })
}

function statusError(response, route, path, authenticated) {
  const status = response.status, code = response.headers.get('x-error-code'), message = response.headers.get('x-error-message')
  const details = { status, path }
  if (code === 'GatedRepo') return new HfGatedError('This Hugging Face model is gated', { ...details, code: 'HF_GATED' })
  if (message === 'Access to this resource is disabled.') return new HfDisabledError('This Hugging Face model is disabled', { ...details, code: 'HF_DISABLED' })
  if (code === 'RevisionNotFound') return new HfNotFoundError('Hugging Face revision not found', { ...details, code: 'HF_REVISION_NOT_FOUND' })
  // Anonymous callers get 401 for missing and private repositories alike (huggingface_hub reads both as "not found"). With
  // a token, an unexplained 401 means the token was refused: a revoked token must never make models look gone.
  if (status === 404 || code === 'RepoNotFound' || (route.repo && status === 401 && !authenticated)) {
    return new HfNotFoundError(route.missing ?? 'Hugging Face resource not found', { ...details, code: 'HF_NOT_FOUND' })
  }
  if (status === 401) return new HfUpstreamError('Hugging Face refused the request credentials', { ...details, code: 'HF_UNAUTHORIZED' })
  return new HfUpstreamError(`Hugging Face returned HTTP ${status}`, { ...details, code: `HF_HTTP_${status}` })
}

async function readJson(response) {
  const tooLarge = Number(response.headers.get('content-length')) > MAX_BODY_BYTES
  if (tooLarge || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge ? new HfUpstreamError('Hugging Face response is too large', { code: 'HF_TOO_LARGE' })
      : new HfUpstreamError('Hugging Face returned an unexpected body', { code: 'HF_INVALID_RESPONSE' })
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) throw new HfUpstreamError('Hugging Face response is too large', { code: 'HF_TOO_LARGE' })
      chunks.push(chunk)
    }
  } catch (error) { throw error instanceof HfApiError ? error : transportError(error) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new HfUpstreamError('Hugging Face returned invalid JSON', { code: 'HF_INVALID_RESPONSE' })
  }
}

// A redirect may only change the key (model path or account handle) of the same endpoint on the same host; the next
// URL is rebuilt from our own prefix, suffix and query, so nothing else in the Location is used.
function redirectKey(location, from, route) {
  if (!location || location.length > 2048) return null
  let url
  try { url = new URL(location, from) } catch { return null }
  const path = url.pathname
  if (url.origin !== HF_ORIGIN || url.username || url.password || !path.startsWith(route.prefix) || !path.endsWith(route.suffix)) return null
  const key = path.slice(route.prefix.length, path.length - route.suffix.length)
  return route.isKey(key) ? key : null
}

function toModel(info, redirectedFrom) {
  const licenses = info.tags.filter(tag => tag.startsWith('license:')).map(tag => cleanText(tag.slice(8), 64)).filter(Boolean)
  return {
    hfId: info._id, path: info.id, owner: { handle: info.author }, private: info.private, disabled: info.disabled, gated: info.gated,
    createdAt: info.createdAt, lastModified: info.lastModified, sha: info.sha, pipelineTag: info.pipeline_tag,
    license: [...new Set(licenses)].join(', ') || null, likes: info.likes, downloads30d: info.downloads,
    downloadsAllTime: info.downloadsAllTime, trendingScore: info.trendingScore,
    baseModels: info.baseModels && { relation: info.baseModels.relation, models: info.baseModels.models.map(base => ({ hfId: base._id, path: base.id })) },
    childrenCount: info.childrenModelCount && Object.values(info.childrenModelCount).reduce((sum, n) => sum + n, 0),
    spacesCount: info.spaces && info.spaces.length, redirectedFrom,
  }
}

const modelRoute = (path, suffix = '', query = '') => ({ prefix: '/api/models/', key: path, suffix, query, isKey: isHfModelPath, repo: true,
  missing: 'Hugging Face model not found or private' })
const accountRoute = (prefix, name, missing) => ({ prefix, key: name, suffix: '/overview', query: '', isKey: isHfName, repo: false, missing })

// reserve: fraction of each rate-limit window this client leaves unspent for other callers on the same token or IP
// (the worker passes 0.6 to use at most 40%). Waits longer than maxWaitMs throw HfRateLimitedError with retryAt instead.
export function createHfClient({ token = null, fetchImpl = fetch, timeoutMs = 10_000, retries = 2, maxWaitMs = 15_000, reserve = 0.1,
  userAgent = 'repo.ing', now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (token !== null && !(typeof token === 'string' && /^[\x21-\x7e]{8,512}$/.test(token))) throw new TypeError('Invalid Hugging Face token')
  if (!(reserve >= 0 && reserve < 1)) throw new TypeError('reserve must be a fraction from 0 up to 1')
  const headers = { Accept: 'application/json', 'User-Agent': userAgent, ...token ? { Authorization: `Bearer ${token}` } : {} }
  let rate = null

  const limited = retryAt => new HfRateLimitedError('Hugging Face rate limit reached', { code: 'HF_RATE_LIMITED', retryAt })

  async function pace() {
    if (!rate) return
    const left = rate.resetAt - now()
    if (left <= 0) { rate = null; return }
    if (rate.remaining > (rate.quota === null ? 0 : Math.ceil(rate.quota * reserve))) { rate = { ...rate, remaining: rate.remaining - 1 }; return }
    if (left > maxWaitMs) throw limited(rate.resetAt)
    await sleep(left)
    rate = null
  }

  async function send(url) {
    for (let attempt = 0; ; attempt++) {
      await pace()
      let response
      try {
        response = await fetchImpl(url, { headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) { throw transportError(error) }
      const reading = parseRateLimit(response.headers)
      if (reading) {
        const resetAt = now() + reading.resetSeconds * 1000
        // Concurrent responses can arrive out of order: within one window the lowest remaining count wins.
        const remaining = rate && Math.abs(rate.resetAt - resetAt) < 2000 ? Math.min(rate.remaining, reading.remaining) : reading.remaining
        rate = { bucket: reading.bucket, remaining, resetAt, quota: reading.quota, windowSeconds: reading.windowSeconds }
      }
      if (!RETRIED.has(response.status)) return response
      await response.body?.cancel().catch(() => {})
      const backoff = Math.min(1000 * 2 ** attempt, 8000)
      const throttled = response.status === 429
      const delay = throttled ? Math.max(reading ? reading.resetSeconds * 1000 : 0, retryAfterMs(response.headers, now())) || backoff : backoff
      // A 429 holds every later request until it clears, even when it came without RateLimit headers.
      if (throttled) rate = { bucket: null, quota: null, windowSeconds: null, ...rate, remaining: 0, resetAt: now() + delay }
      if (attempt >= retries || delay > maxWaitMs) {
        throw throttled ? limited(now() + delay)
          : new HfUpstreamError(`Hugging Face returned HTTP ${response.status}`, { code: `HF_HTTP_${response.status}`, status: response.status })
      }
      await sleep(delay)
    }
  }

  async function getJson(route, follow) {
    let key = route.key, redirectedFrom = null
    const seen = new Set([key])
    for (let hops = 0; ; hops++) {
      const url = `${HF_ORIGIN}${route.prefix}${key}${route.suffix}${route.query}`
      const response = await send(url)
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel().catch(() => {})
        if (!follow) throw new HfUpstreamError('Hugging Face path moved', { code: 'HF_MOVED', status: response.status, path: key })
        if (hops >= MAX_REDIRECTS) throw new HfUpstreamError('Too many Hugging Face redirects', { code: 'HF_TOO_MANY_REDIRECTS', path: route.key })
        const next = redirectKey(response.headers.get('location'), url, route)
        if (!next || seen.has(next)) throw new HfUpstreamError('Refused a Hugging Face redirect', { code: 'HF_REDIRECT_REFUSED', path: key })
        seen.add(next)
        redirectedFrom ??= route.key
        key = next
        continue
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
        throw statusError(response, route, key, token !== null)
      }
      return { data: await readJson(response), headers: response.headers, key, redirectedFrom }
    }
  }

  async function model({ path } = {}) {
    const { data, key, redirectedFrom } = await getJson(modelRoute(parseHfModelUrl(path).path, '', MODEL_QUERY), true)
    const info = validate(modelSchema, data, 'model')
    if (info.id.toLowerCase() !== key.toLowerCase() || info.author !== info.id.split('/')[0]) throw mismatch(key)
    const found = toModel(info, redirectedFrom)
    const details = { path: found.path, hfId: found.hfId }
    if (found.private) throw new HfPrivateError('This Hugging Face model is private', { ...details, code: 'HF_PRIVATE' })
    if (found.disabled) throw new HfDisabledError('This Hugging Face model is disabled', { ...details, code: 'HF_DISABLED' })
    return found
  }

  async function account(route, schema, kind) {
    if (!isHfName(route.key)) throw new HfUrlError('Invalid Hugging Face account name')
    const { data, key, redirectedFrom } = await getJson(route, true)
    const info = validate(schema, data, kind)
    const name = kind === 'user' ? info.user : info.name
    if (name.toLowerCase() !== key.toLowerCase()) throw mismatch(key)
    return { id: info._id, handle: name, kind, fullname: info.fullname, avatarUrl: avatarUrl(info.avatarUrl), redirectedFrom }
  }
  const userOverview = name => account(accountRoute('/api/users/', name, 'Hugging Face user not found'), userSchema, 'user')
  const orgOverview = name => account(accountRoute('/api/organizations/', name, 'Hugging Face organization not found'), orgSchema, 'org')

  // Users and organizations share one namespace; a model's author is whichever of the two exists.
  async function owner(name) {
    try { return await userOverview(name) } catch (error) { if (!(error instanceof HfNotFoundError)) throw error }
    try { return await orgOverview(name) } catch (error) {
      throw error instanceof HfNotFoundError ? new HfNotFoundError('Hugging Face account not found', { code: 'HF_NOT_FOUND', path: name }) : error
    }
  }

  function canonical(path) {
    if (!isHfModelPath(path)) throw new HfUrlError('Invalid Hugging Face model path')
    return path
  }

  async function commitsCount(path, { revision = 'main' } = {}) {
    if (typeof revision !== 'string' || !/^\w[\w.-]{0,127}$/.test(revision) || revision.includes('..')) throw new HfUrlError('Invalid revision')
    const { data, headers } = await getJson(modelRoute(canonical(path), `/commits/${revision}`, '?limit=1'), false)
    validate(commitsSchema, data, 'commits')
    const total = headers.get('x-total-count') ?? ''
    if (!/^\d{1,15}$/.test(total)) throw new HfUpstreamError('Hugging Face did not report a commit count', { code: 'HF_INVALID_RESPONSE', path })
    return Number(total)
  }

  async function discussionsCount(path) {
    const { data } = await getJson(modelRoute(canonical(path), '/discussions'), false)
    const { count: total, numClosedDiscussions: closed } = validate(discussionsSchema, data, 'discussions')
    if (closed !== null && closed > total) throw new HfUpstreamError('Unexpected Hugging Face discussions response', { code: 'HF_INVALID_RESPONSE', path })
    return { total, open: closed === null ? null : total - closed, closed }
  }

  // Trending entries carry the owner's _id and kind but not the model's own _id: resolve one with model() before use.
  async function trendingModels({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RangeError('limit must be from 1 to 20')
    const route = { prefix: '/api/trending', key: '', suffix: '', query: `?type=model&limit=${limit}`, isKey: () => false, repo: false }
    const { data } = await getJson(route, false)
    return validate(trendingSchema, data, 'trending').recentlyTrending.filter(item => item.repoType === 'model').map((item, index) => {
      const info = validate(trendingModelSchema, item.repoData, 'trending model')
      const ownerHandle = info.id.split('/')[0]
      if (info.author !== ownerHandle || (info.authorData && info.authorData.name !== ownerHandle)) throw mismatch(info.id)
      return { rank: index + 1, path: info.id,
        owner: info.authorData ? { handle: ownerHandle, kind: info.authorData.type, id: info.authorData._id } : { handle: ownerHandle },
        private: info.private, gated: info.gated, likes: info.likes, downloads30d: info.downloads, lastModified: info.lastModified,
        pipelineTag: info.pipeline_tag }
    })
  }

  return { model, userOverview, orgOverview, owner, commitsCount, discussionsCount, trendingModels, rateLimit: () => rate && { ...rate } }
}
