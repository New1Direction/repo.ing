// Display rules for Hugging Face model markets (lists, cards, token page, metadata). Pure and dependency-light, so client
// components can import it; reads and the HF_MARKETS_ENABLED flag live in hf-markets.mjs (server only).
import { HF_DISCLAIMER, HF_DISCLAIMER_BADGE, HF_DISCLAIMER_SHORT } from '../../src/hf-copy.mjs'
import { hfModelUrl, isHfModelPath } from '../../src/hf-url.mjs'
import { isMarketId, marketSource } from '../../src/market-identity.mjs'
import { builderEarningsHeadline } from './builder-earnings.mjs'
import { formatSolDisplay, formatUsdEstimate } from './format.mjs'

export { HF_DISCLAIMER, HF_DISCLAIMER_BADGE, HF_DISCLAIMER_SHORT }
// Source label on model rows and cards. Text only: the Hugging Face logo is never used.
export const MODEL_SOURCE_LABEL = 'Hugging Face'
export const MODEL_SOURCE_TITLE = 'A market for a public Hugging Face model'

// The id decides the source (src/market-identity.mjs): a model market's id is its hf_models.market_ref. Rows without an
// id (none today) fall back to their source column.
export function isModelMarket(market) {
  const id = market?.repoId
  if (id !== undefined && id !== null && isMarketId(String(id))) return marketSource(String(id)) === 'huggingface'
  return market?.source === 'huggingface'
}

// https://huggingface.co/<owner>/<name>; null for anything that is not a model path, so no link is ever guessed.
export function modelPageUrl(path) {
  if (!isHfModelPath(path)) return null
  return hfModelUrl(path)
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
// A model's likes as its launch recorded them: repositories.stars holds them for model markets (the column predates
// model markets, like github_repo_id holding model ids). An object that carries likes itself (a fresh Hub read) wins.
// Live counts on the token page come from the model card read (hf-markets.mjs).
export function storedLikes(market) {
  return count(market?.likes) ?? count(market?.stars)
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
export const compactCount = value => Number.isSafeInteger(value) && value >= 0 ? COMPACT.format(value) : '—'
export const exactCount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—'

// Hub pipeline tags read as tasks: text-generation → "Text generation".
export function taskLabel(tag) {
  if (typeof tag !== 'string' || tag.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/.test(tag)) return null
  const words = tag.replaceAll('-', ' ')
  return words[0].toUpperCase() + words.slice(1)
}

// Gated: the Hub reports false, 'auto' or 'manual' (the registry stores a boolean).
export function gatedLabel(gated) {
  if (gated === 'manual') return { label: 'Gated', title: 'Access is granted by the model’s authors after a request on Hugging Face' }
  if (gated === 'auto' || gated === true) return { label: 'Gated', title: 'Access requires accepting the model’s conditions on Hugging Face' }
  return null
}

const RELATIONS = new Set(['quantized', 'finetune', 'adapter', 'merge'])
// Base models from the live card ({ relation, models: [{ hfId, path }] }) or the registry's base_models (an array of
// paths or { path } / { id } objects). Only valid model paths are kept; duplicates are dropped.
export function baseModels(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : []
  const paths = [...new Set(list.map(item => typeof item === 'string' ? item : item?.path ?? item?.id).filter(isHfModelPath))]
  if (!paths.length) return null
  return { relation: RELATIONS.has(value?.relation) ? value.relation : null, paths }
}

// "Derivative of <base>" badge: the first base model, and how many more there are.
export function derivativeLabel(base) {
  if (!base?.paths?.length) return null
  const [first, ...rest] = base.paths
  return { label: `Derivative of ${first}${rest.length ? ` +${rest.length}` : ''}`, href: modelPageUrl(first),
    title: `${base.relation ? `${base.relation[0].toUpperCase()}${base.relation.slice(1)} of` : 'Derived from'} ${base.paths.join(', ')}` }
}

// Everything a model surface shows, from the market row, its registry row (hf_models) and, when the Hub returned this
// registry row's own _id, the live card. Live facts win; without them only stored facts are shown, never guesses.
export function modelView(market, registry = null, card = null) {
  const live = card?.status === 'live' ? card : null
  const path = live?.path ?? registry?.path ?? market?.fullName ?? ''
  const [owner = '', name = ''] = path.split('/')
  return {
    path, owner, name, ownerKind: registry?.ownerKind ?? null, hfId: registry?.hfId ?? null,
    // A moved path now names a different repository: no link to it, and no live facts from it.
    url: card?.status === 'moved' ? null : modelPageUrl(path),
    moved: card?.status === 'moved', live: Boolean(live),
    task: taskLabel(live?.pipelineTag) ?? null, license: live?.license ?? null,
    gated: gatedLabel(live ? live.gated : registry?.gated),
    base: baseModels(live?.baseModels ?? registry?.baseModels),
    likes: count(live?.likes) ?? storedLikes(market), downloads30d: count(live?.downloads30d) ?? count(market?.downloads30d),
    updatedAt: live?.lastModified ?? market?.updatedAt ?? null,
  }
}

// Home "Hugging Face models" strip: model markets traded in the last 24h first, by volume, then newest.
export const MODEL_STRIP_LIMIT = 8
export function selectModelStrip(markets, { limit = MODEL_STRIP_LIMIT } = {}) {
  const volume = market => BigInt(market.volume24hLamports ?? '0'), launched = market => new Date(market.indexedAt).getTime() || 0
  return markets.filter(isModelMarket).sort((a, b) => {
    const av = volume(a), bv = volume(b)
    if (av !== bv) return av > bv ? -1 : 1
    return launched(b) - launched(a) || a.mint.localeCompare(b.mint)
  }).slice(0, limit).map(market => ({ repoId: String(market.repoId), mint: market.mint, fullName: market.fullName, symbol: market.symbol,
    volume24hLamports: String(market.volume24hLamports ?? '0'), likes: storedLikes(market) }))
}

// One line under a model's name in lists and the token page: the disclaimer badge, then what the model does.
export function modelSummary(market, view = null) {
  return [HF_DISCLAIMER_BADGE, view?.task ?? market?.description ?? 'Public Hugging Face model'].filter(Boolean).join(' · ')
}

// Token page hero headline: builder-earnings.mjs's evidence gate and amounts, in model-owner words.
export function modelEarningsHeadline(market, fees, usdPerSol) {
  const view = builderEarningsHeadline(market, fees, usdPerSol)
  if (!view) return null
  const claimable = BigInt(fees.onchainCreatorFee ?? 0)
  const label = {
    claim: view.action.label,
    verify: `Model owner? Verify to claim ${formatUsdEstimate(claimable, usdPerSol) ?? `${formatSolDisplay(claimable)} SOL`}`,
    note: BigInt(market.claimed ?? 0) > 0n && market.beneficiaryWallet ? 'Paid to the model’s verified owner' : 'The model’s owner earns from every trade',
  }[view.action.kind]
  return { ...view, action: { ...view.action, label } }
}

// Metadata, share and alert copy. Every one carries the disclaimer (tests/hf-disclaimer.test.mjs).
export function modelMetaDescription(market) {
  return `${HF_DISCLAIMER_SHORT}. $${market.symbol} is the repo.ing market for the Hugging Face model ${market.fullName}. Every trade pays the model’s owner in SOL.`
}
export const modelShareText = market => `${market.fullName} on repo.ing. ${HF_DISCLAIMER_SHORT}`
