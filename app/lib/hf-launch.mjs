import { drizzle } from 'drizzle-orm/node-postgres'
import { database } from './server.mjs'
import { clientKey } from './holder-notes.mjs'
import { hfClient } from './hf-client.mjs'
import { HF_MARKETS_UNAVAILABLE, HF_OPT_OUT_ERROR, hfMarketsEnabled, isHfMarketId, modelLookupError, persistModelRepository,
  resolveModel } from '../../src/hf-launch.mjs'
import { activeDecision } from '../../src/maintainer-opt-outs.mjs'
import { takeQuota } from '../../src/request-quota.mjs'
import { normalizeTokenImage, readLimitedBody } from '../../src/token-image.mjs'

// Web side of Hugging Face model launches (src/hf-launch.mjs). Everything is dormant until HF_MARKETS_ENABLED=true.

const LIVE_MINT = `select mint from markets where github_repo_id = $1 and status = 'confirmed' and indexed_at is not null
  and launch_finality = 'finalized'`
// The anonymous Hugging Face budget is per server IP (500 requests per 5 minutes, about 90 a minute after the client's
// reserve). A lookup (resolve, or a prepare, which reads the model and its owner, then the model again) spends up to four,
// so web lookups are capped at 20 a minute in all and 6 per client; agents share the global cap. Shared by every replica
// (agent_request_limits, src/request-quota.mjs). The client scope is checked first, so a client over its own limit never
// spends the shared one.
export const MODEL_LOOKUP_LIMITED = 'Too many model lookups. Try again in a minute.'
const LOOKUP_QUOTA = { client: [6, 60], global: [20, 60] }
export const takeModelLookup = (pool, request) => takeQuota(pool, [...request ? [[`hf-lookup:client:${clientKey(request)}`, ...LOOKUP_QUOTA.client]] : [],
  ['hf-lookup:global', ...LOOKUP_QUOTA.global]])

// POST /api/resolve for a Hugging Face URL: the market id and live mint, like a repository, plus source. The model is read
// by its _id every time (no path shortcut: a path can come to name a different model).
export async function resolveModelRequest(input, request) {
  if (!hfMarketsEnabled()) return Response.json({ error: HF_MARKETS_UNAVAILABLE, code: 'HF_MARKETS_UNAVAILABLE' }, { status: 400 })
  const pool = database()
  if (!pool) return Response.json({ error: 'Database is not configured' }, { status: 503 })
  try {
    if (!await takeModelLookup(pool, request)) {
      return Response.json({ error: MODEL_LOOKUP_LIMITED, code: 'HF_LOOKUP_LIMITED' }, { status: 429, headers: { 'Retry-After': '60' } })
    }
    const repo = await resolveModel({ pool, hf: hfClient(), input })
    await persistModelRepository(drizzle(pool), repo)
    const repoId = repo.githubRepoId.toString()
    const { rows } = await pool.query(LIVE_MINT, [repoId])
    // Without a market the next step is a launch: refuse it when the owner opted the model out.
    if (!rows[0]?.mint && await activeDecision(pool, repoId)) return Response.json({ error: HF_OPT_OUT_ERROR, code: 'MAINTAINER_OPTED_OUT' }, { status: 403 })
    return Response.json({ repoId, mint: rows[0]?.mint ?? null, source: 'huggingface' })
  } catch (error) {
    const refusal = modelLookupError(error)
    if (refusal.status >= 500) console.error('hf_resolve_failed', { code: error?.code ?? error?.name ?? 'error' })
    return Response.json({ error: refusal.message, code: refusal.code }, { status: refusal.status })
  }
}

// The launch page's model (written when it was resolved): null when unknown, undefined when it cannot be read.
export async function modelForLaunch(repoId) {
  const pool = database()
  if (!pool || !isHfMarketId(repoId)) return null
  try {
    const { rows: [row] } = await pool.query(`select r.github_repo_id::text as "repoId", r.owner, r.name, r.full_name as "fullName",
        r.description, r.github_updated_at as "updatedAt", r.github_created_at as "createdAt", h.hf_id as "hfId",
        h.owner_kind as "ownerKind", h.gated, h.base_models as "baseModels"
      from repositories r join hf_models h on h.market_ref = r.hf_model_ref
      where r.github_repo_id = $1 and r.source = 'huggingface'`, [String(repoId)])
    if (!row) return null
    const iso = value => value ? new Date(value).toISOString() : null
    return { ...row, source: 'huggingface', updatedAt: iso(row.updatedAt), createdAt: iso(row.createdAt) }
  } catch (error) {
    console.error('model launch read failed', { code: error?.code ?? error?.name ?? 'error' })
    return undefined
  }
}

// Owner avatars exactly as src/hf-api.mjs stores them: the Hub's CDN or avatar paths without a query, or a Gravatar hash
// with the built-in default. Nothing else is ever fetched.
const AVATARS = [/^https:\/\/cdn-avatars\.huggingface\.co\/v1\/production\/uploads\/[\w./-]+$/,
  /^https:\/\/huggingface\.co\/avatars\/[\w.-]+$/, /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32,64}\?d=retro$/]
export const safeHfAvatarUrl = value => typeof value === 'string' && value.length <= 1000 && !value.includes('..') &&
  AVATARS.some(pattern => pattern.test(value)) ? value : null

// Token art from an avatar: no redirects (one could lead anywhere), no credentials, 5 s, at most 2 MB.
export async function fetchHfAvatar(value, fetchImpl = fetch) {
  const url = safeHfAvatarUrl(value)
  if (!url) throw Error('Unsupported image source')
  const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw Error('Image could not be loaded') }
  return readLimitedBody(response)
}

const AVATAR_CACHE_LIMIT = 32, AVATARS_IN_FLIGHT = 8
const avatars = new Map(), pendingAvatars = new Map()

// The launch picker's suggestion for a model: its owner's avatar (upload stays available). record: the repositories row.
// Like the repository suggestions (app/lib/repo-images.mjs), at most a few fetch-and-decode jobs run at once.
export async function modelImageSuggestions(record, { fetchImpl = fetch, now = Date.now } = {}) {
  const source = safeHfAvatarUrl(record?.avatar_url)
  if (!source) return []
  const cached = avatars.get(source)
  if (cached?.expiresAt > now()) return cached.images
  if (pendingAvatars.has(source)) return pendingAvatars.get(source)
  if (pendingAvatars.size >= AVATARS_IN_FLIGHT) throw Error('Image suggestions are busy. Please try again.')
  const job = (async () => {
    let images = []
    try {
      const normalized = await normalizeTokenImage(await fetchHfAvatar(source, fetchImpl), { allowSvg: true })
      images = [{ image: normalized.image, label: 'Owner avatar', source }]
    } catch { /* No suggestion; uploading still works. */ }
    if (avatars.size >= AVATAR_CACHE_LIMIT) avatars.delete(avatars.keys().next().value)
    avatars.set(source, { images, expiresAt: now() + (images.length ? 10 : 1) * 60_000 })
    return images
  })()
  pendingAvatars.set(source, job)
  try { return await job } finally { pendingAvatars.delete(source) }
}
