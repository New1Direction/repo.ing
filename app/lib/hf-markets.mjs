// Server side of Hugging Face model markets' pages and lists: the registry read (hf_models, migration 0049), the live
// model card, the display-only facts lists show and the logo route's avatar hosts. Display rules are in
// hf-model-display.mjs; the flag, the Hub client and the avatar allowlist are the launch's (src/hf-launch.mjs,
// hf-client.mjs, hf-launch.mjs).
import { cache } from 'react'
import { database } from './server.mjs'
import { HfDisabledError, HfNotFoundError, HfPrivateError } from '../../src/hf-api.mjs'
import { hfMarketsEnabled } from '../../src/hf-launch.mjs'
import { hfClient } from './hf-client.mjs'
import { safeHfAvatarUrl } from './hf-launch.mjs'
import { isModelMarket } from './hf-model-display.mjs'

// Every model surface (token page, list rows, the Models filter and home strip, the /stats split, model logos) is off
// unless HF_MARKETS_ENABLED is exactly "true"; off, the site renders as it did before model markets.
export { hfMarketsEnabled }

// The logo route's model branch serves only avatars on the Hub's own hosts: the launch's allowlist (which also admits a
// Gravatar hash, for the launch picker's suggestion) narrowed to cdn-avatars.huggingface.co and huggingface.co. The image
// proxy checks it again on every redirect hop.
const HUB_AVATAR_HOSTS = new Set(['cdn-avatars.huggingface.co', 'huggingface.co'])
export function hubAvatarUrl(value) {
  const url = safeHfAvatarUrl(value)
  return url && HUB_AVATAR_HOSTS.has(new URL(url).hostname) ? url : null
}

// Lists drop model markets while the flag is off.
export const shownMarkets = (markets, env = process.env) => hfMarketsEnabled(env) ? markets : markets.filter(market => !isModelMarket(market))

// The model's registry row: its stable _id, last confirmed path and owner, and the gated and base-model state the launch
// recorded. null for a GitHub id, a missing row, or no database.
const REGISTRY_COLUMNS = `market_ref::text as "marketRef", hf_id as "hfId", repo_path as path, owner_handle as "ownerHandle",
  owner_kind as "ownerKind", owner_subject as "ownerSubject", gated, base_models as "baseModels", path_confirmed_at as "pathConfirmedAt"`
export async function readModelRegistry(pool, marketId) {
  if (!pool || !isModelMarket({ repoId: marketId })) return null
  const { rows: [row] } = await pool.query(`select ${REGISTRY_COLUMNS} from hf_models where market_ref = $1`, [String(marketId)])
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

// Reads go through the web process's one Hub client (hf-client.mjs), so the launch path and these display reads share
// one pacing of the anonymous rate limit.
function liveCards() {
  globalThis.__repoingHfModelCards ??= createModelCards({ read: path => hfClient().model({ path }) })
  return globalThis.__repoingHfModelCards
}

// Display-only facts per market id (likes and 30-day downloads), from the last live card. Lists show them without a Hub
// request of their own; they never order, promote or pay anything. Every card outcome is remembered with when to ask
// again (as the card cache would), so a model the Hub does not answer for is not re-read on every list view. A transient
// failure keeps the last known figures; a moved or missing model drops them. Figures older than FACTS_MAX_AGE_MS are not
// shown.
const FACTS_LIMIT = 2000
export const FACTS_MAX_AGE_MS = 6 * 60 * 60_000
const facts = globalThis.__repoingHfModelFacts ??= new Map()
function recordFacts(registry, card, now = Date.now()) {
  if (!registry.marketRef) return
  const key = String(registry.marketRef), previous = facts.get(key)
  const known = card.status === 'live' ? { likes: card.likes, downloads30d: card.downloads30d, at: now }
    : card.status === 'unavailable' && previous?.at ? previous : { likes: null, downloads30d: null, at: null }
  if (!previous && facts.size >= FACTS_LIMIT) facts.delete(facts.keys().next().value)
  facts.set(key, { ...known, refreshAt: now + (card.status === 'unavailable' ? MODEL_CARD_FAILURE_MS : MODEL_CARD_TTL_MS) })
}
// waitMs bounds how long a page render waits (the shared client may pace or retry): past it the render shows stored
// facts, and the read still completes and fills the caches for the next view. 0 waits for the read (background refreshes).
export const MODEL_CARD_WAIT_MS = 4000
export function modelCard(registry, { waitMs = MODEL_CARD_WAIT_MS } = {}) {
  const card = liveCards()(registry).then(value => { recordFacts(registry ?? {}, value); return value })
  if (!waitMs) return card
  let timer
  const late = new Promise(resolve => { timer = setTimeout(resolve, waitMs, { status: 'unavailable' }); timer.unref?.() })
  return Promise.race([card, late]).finally(() => clearTimeout(timer))
}

// List rows with each model's display-only facts attached (likes, downloads30d). Models with none, or none fresher than
// the card TTL, are refreshed through schedule (pages pass next/server's after, so it runs after the response; at most
// refreshLimit per call, through the same cached, rate-limited card reads), so a later view shows them. Without the flag,
// or with no model in the list, the rows come back as they are. (next/server is not imported here: plain Node imports
// this module through the logo route.)
export const MODEL_FACTS_REFRESH_LIMIT = 12
export function withModelFacts(markets, { schedule = null, now = Date.now, refreshLimit = MODEL_FACTS_REFRESH_LIMIT, pool = null } = {}) {
  if (!hfMarketsEnabled() || !markets.some(isModelMarket)) return markets
  const at = now()
  const stale = markets.filter(market => isModelMarket(market) && !(facts.get(String(market.repoId))?.refreshAt > at))
    .slice(0, refreshLimit).map(market => String(market.repoId))
  if (stale.length && schedule) schedule(() => refreshModelFacts(pool ?? database(), stale))
  return markets.map(market => {
    const known = isModelMarket(market) && facts.get(String(market.repoId))
    return known?.at && at - known.at < FACTS_MAX_AGE_MS ? { ...market, likes: known.likes, downloads30d: known.downloads30d } : market
  })
}

async function refreshModelFacts(pool, marketIds) {
  if (!pool) return
  try {
    const { rows } = await pool.query(`select ${REGISTRY_COLUMNS} from hf_models where market_ref = any($1::bigint[])`, [marketIds])
    await Promise.all(rows.map(row => modelCard(row, { waitMs: 0 })))
  } catch (error) { console.error('hf model facts refresh failed', { error: error.message }) }
}
