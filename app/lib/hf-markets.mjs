// Server side of Hugging Face model markets in the web app: the HF_MARKETS_ENABLED flag, the registry read (hf_models,
// migration 0049) and the live model card. Display rules are in hf-model-display.mjs.
import { cache } from 'react'
import { database } from './server.mjs'
import { createHfClient, HfDisabledError, HfNotFoundError, HfPrivateError } from '../../src/hf-api.mjs'
import { isModelMarket } from './hf-model-display.mjs'

// Every model surface (token page, list rows, the Models filter and home strip, the /stats split, model logos) is off
// unless HF_MARKETS_ENABLED is exactly "true"; off, the site renders as it did before model markets.
export const hfMarketsEnabled = (env = process.env) => env.HF_MARKETS_ENABLED === 'true'

// Lists drop model markets while the flag is off.
export const shownMarkets = (markets, env = process.env) => hfMarketsEnabled(env) ? markets : markets.filter(market => !isModelMarket(market))

// The model's registry row: its stable _id, last confirmed path and owner, and the gated and base-model state the launch
// recorded. null for a GitHub id, a missing row, or no database.
export async function readModelRegistry(pool, marketId) {
  if (!pool || !isModelMarket({ repoId: marketId })) return null
  const { rows: [row] } = await pool.query(`select hf_id as "hfId", repo_path as path, owner_handle as "ownerHandle", owner_kind as "ownerKind",
    owner_subject as "ownerSubject", gated, base_models as "baseModels", path_confirmed_at as "pathConfirmedAt"
    from hf_models where market_ref = $1`, [String(marketId)])
  return row ?? null
}

// Once per render: the page and its metadata share the read. A failed read shows stored facts only.
export const modelRegistry = cache(marketId => readModelRegistry(database(), marketId).catch(error => {
  console.error('hf model registry read failed', { marketId: String(marketId), error: error.message })
  return null
}))

// Live model facts for display only (never a payout or launch decision): one anonymous Hub read per model per ttlMs,
// shared by every viewer of this process, with in-flight reads deduplicated. The Hub's answer counts only when it carries
// the registry row's own _id: a path can be redirected to a different repository ('moved'). A model the Hub no longer
// serves publicly is 'missing'; any other failure is 'unavailable' and is retried after failureMs.
export const MODEL_CARD_TTL_MS = 10 * 60_000
export const MODEL_CARD_FAILURE_MS = 60_000
const CARD_LIMIT = 500
const LIVE_FIELDS = ['hfId', 'path', 'pipelineTag', 'license', 'likes', 'downloads30d', 'gated', 'baseModels', 'lastModified', 'redirectedFrom']

export function createModelCards({ read, now = Date.now, ttlMs = MODEL_CARD_TTL_MS, failureMs = MODEL_CARD_FAILURE_MS, limit = CARD_LIMIT }) {
  const cards = new Map(), pending = new Map()
  async function load(registry) {
    try {
      const model = await read(registry.path)
      if (model?.hfId !== registry.hfId) return { status: 'moved' }
      return { status: 'live', ...Object.fromEntries(LIVE_FIELDS.map(key => [key, model[key] ?? null])) }
    } catch (error) {
      if (error instanceof HfNotFoundError || error instanceof HfPrivateError || error instanceof HfDisabledError) return { status: 'missing' }
      console.error('hf model card unavailable', { path: registry.path, code: error?.code ?? error?.name })
      return { status: 'unavailable' }
    }
  }
  return function modelCard(registry) {
    if (!registry?.hfId || !registry?.path) return Promise.resolve({ status: 'unavailable' })
    const key = registry.hfId, hit = cards.get(key)
    if (hit && now() < hit.expiresAt) return Promise.resolve(hit.value)
    if (!pending.has(key)) pending.set(key, load(registry).then(value => {
      if (cards.size >= limit) cards.delete(cards.keys().next().value)
      cards.set(key, { value, expiresAt: now() + (value.status === 'unavailable' ? failureMs : ttlMs) })
      return value
    }).finally(() => pending.delete(key)))
    return pending.get(key)
  }
}

// Fails fast and leaves half of the anonymous rate-limit window to the launch path on the same address: no retries, no
// waiting for a window to reset.
function liveCards() {
  globalThis.__repoingHfModelCards ??= (() => {
    const hf = createHfClient({ userAgent: 'repo.ing-web', timeoutMs: 4000, retries: 0, maxWaitMs: 0, reserve: 0.5 })
    return createModelCards({ read: path => hf.model({ path }) })
  })()
  return globalThis.__repoingHfModelCards
}
export const modelCard = registry => liveCards()(registry)
