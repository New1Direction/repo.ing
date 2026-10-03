import { sql } from 'drizzle-orm'
import { repositories } from './db/schema.mjs'
import { HfDisabledError, HfNotFoundError, HfPrivateError, HfRateLimitedError, HfUrlError } from './hf-api.mjs'
import { assertHfMarketId, isMarketId, marketSource } from './market-identity.mjs'
import { activeDecision } from './maintainer-opt-outs.mjs'
import { defaultTokenName, defaultTokenSymbol } from '../app/lib/launch-defaults.mjs'

// Launching Hugging Face model markets. A model market is keyed to the model repository's stable _id, never to its
// owner/name path: a path is only how a model is found, and every read checks the _id it lands on (a rename or transfer
// can make an old path redirect to a different repository; docs/HUGGING_FACE_API_NOTES.md). The hf_models registry
// (migration 0049) gives each _id one market id, ever (UNIQUE hf_id; market_ref is frozen by a trigger), and that id lives
// in the github_repo_id columns like a repository id, so locks, launch sessions and ledgers work unchanged.
// Dormant: nothing here runs until HF_MARKETS_ENABLED=true.
//
// Refused: private and disabled models (hf.model() throws for both), a missing model, a path that now names a different
// _id than the one being launched, and a model whose owner opted it out (maintainer_opt_outs, read like a repository's).
// Allowed: any other public model, gated models and quantized or fine-tuned re-uploads included.
export const HF_MARKETS_UNAVAILABLE = 'Hugging Face model markets are not available yet.'
export const HF_OPT_OUT_ERROR = "The model's owner has opted this model out of repo.ing"
export const HF_MODEL_MOVED = 'This model moved on Hugging Face. Paste its current Hugging Face URL and review the launch again.'
// A launch config that reserves the 1% builder allocation (BUILDER_ALLOCATION_CONFIGS) launches model markets too: the
// model market carries the allocation, claimable once by the model's verified Hugging Face owner after graduation
// (src/builder-allocation.mjs).
const MAX_BASE_MODELS = 20

export const hfMarketsEnabled = (env = process.env) => env.HF_MARKETS_ENABLED === 'true'
export const isHfMarketId = id => isMarketId(id) && marketSource(id) === 'huggingface'

export class HfLaunchError extends Error {
  constructor(message, { status = 400, code = 'HF_LAUNCH_REFUSED' } = {}) {
    super(message)
    this.name = 'HfLaunchError'
    this.status = status
    this.code = code
  }
}

// A pasted value that names Hugging Face: huggingface.co, www.huggingface.co or hf.co, with or without the scheme. Every
// other value keeps the GitHub path exactly as before.
const HF_HOST = /^(?:[a-z][a-z\d+.-]*:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)(?:[/?#:]|$)/i
export const namesHuggingFace = value => typeof value === 'string' && HF_HOST.test(value.trim())

// The launch form's defaults (app/lib/launch-defaults.mjs) applied to the model name: at most 32 characters, and a ticker
// of its letters and digits, uppercased, at most 10.
export const modelTokenDefaults = name => ({ tokenName: defaultTokenName(name), tokenSymbol: defaultTokenSymbol(name) })

const RELATIONS = { quantized: 'Quantized from', finetune: 'Fine-tuned from', adapter: 'Adapter for', merge: 'Merged from' }

// The repositories.description of a model market, from what the Hub reports (already cleaned by src/hf-api.mjs):
// "Text generation · License: llama2 · Quantized from meta-llama/Llama-2-7b-hf".
export function modelDescription({ pipelineTag = null, license = null, baseModels = null } = {}) {
  const task = pipelineTag && pipelineTag.replace(/[-_]+/g, ' ').replace(/^\p{Ll}/u, letter => letter.toUpperCase())
  const [base, ...more] = baseModels?.models ?? []
  const derived = base && `${RELATIONS[baseModels.relation] ?? 'Derived from'} ${base.path}${more.length ? ` and ${more.length} more` : ''}`
  return [task, license && `License: ${license}`, derived].filter(Boolean).join(' · ').slice(0, 280) || null
}

const baseModelList = baseModels => (baseModels?.models ?? []).slice(0, MAX_BASE_MODELS)
  .map(base => ({ hfId: base.hfId, path: base.path, relation: baseModels.relation }))

// What a person or an agent is told when a model cannot be read. Hugging Face wording only: anything else is a caller bug or
// an outage and gets the generic retry message.
export function modelLookupError(error) {
  if (error instanceof HfLaunchError) return error
  if (error instanceof HfUrlError) return new HfLaunchError(error.message, { code: 'HF_INVALID_URL' })
  // Anonymous reads cannot tell a missing model from a private one (docs/HUGGING_FACE_API_NOTES.md).
  if (error instanceof HfNotFoundError) return new HfLaunchError('Hugging Face model not found, or it is private.', { status: 404, code: 'HF_NOT_FOUND' })
  if (error instanceof HfPrivateError) return new HfLaunchError('Private Hugging Face models cannot be launched.', { code: 'HF_PRIVATE' })
  if (error instanceof HfDisabledError) return new HfLaunchError('This Hugging Face model is disabled and cannot be launched.', { code: 'HF_DISABLED' })
  if (error instanceof HfRateLimitedError) return new HfLaunchError('Hugging Face is busy. Try again in a minute.', { status: 503, code: 'HF_RATE_LIMITED' })
  return new HfLaunchError('Model lookup is temporarily unavailable. Try again shortly.', { status: 503, code: 'HF_UNAVAILABLE' })
}

// One market id per model _id, ever. The first sighting draws market_ref from hf_market_ref_seq; every later one (after a
// rename or a transfer too) updates the same row's last observed path, owner and flags. Returns the market id (bigint).
export async function registerModel(pool, model, owner) {
  const { rows: [row] } = await pool.query(`insert into hf_models
      (hf_id, repo_path, owner_handle, owner_kind, owner_subject, private, disabled, gated, base_models)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    on conflict (hf_id) do update set repo_path = excluded.repo_path, owner_handle = excluded.owner_handle,
      owner_kind = excluded.owner_kind, owner_subject = excluded.owner_subject, private = excluded.private,
      disabled = excluded.disabled, gated = excluded.gated, base_models = excluded.base_models, path_confirmed_at = now()
    returning market_ref::text as "marketRef"`,
  [model.hfId, model.path, owner.handle, owner.kind, owner.id, model.private, model.disabled, model.gated !== false,
    JSON.stringify(baseModelList(model.baseModels))])
  return assertHfMarketId(row.marketRef)
}

export async function registeredModel(pool, marketRef) {
  if (!isHfMarketId(marketRef)) return null
  const { rows: [row] } = await pool.query(`select hf_id as "hfId", repo_path as "repoPath" from hf_models where market_ref = $1`,
    [String(marketRef)])
  return row ?? null
}

// The repository-shaped row a model market carries through the launch coordinator, the routes and the repositories table.
function modelRepository(marketRef, model, owner) {
  const [ownerHandle, name] = model.path.split('/')
  return { githubRepoId: marketRef, source: 'huggingface', hfId: model.hfId, owner: ownerHandle, name, fullName: model.path,
    description: modelDescription(model), avatarUrl: owner.avatarUrl, ownerKind: owner.kind, gated: model.gated,
    baseModels: baseModelList(model.baseModels), createdAt: model.createdAt, updatedAt: model.lastModified ?? model.createdAt,
    redirectedFrom: model.redirectedFrom }
}

// Reads the model through Hugging Face (a pasted URL, owner/name or the registry path), checks it is the expected one when
// one is given, resolves its owner (user or organization: avatar, kind, _id) and registers it.
export async function resolveModel({ pool, hf, input, expected = null }) {
  let model, owner
  try {
    model = await hf.model({ path: input })
    if (expected?.hfId && model.hfId !== expected.hfId) throw new HfLaunchError(HF_MODEL_MOVED, { status: 409, code: 'HF_MODEL_MOVED' })
  } catch (error) { throw modelLookupError(error) }
  try { owner = await hf.owner(model.owner.handle) } catch (error) {
    throw error instanceof HfNotFoundError
      ? new HfLaunchError("Hugging Face could not confirm this model's owner. Try again later.", { status: 503, code: 'HF_OWNER_UNAVAILABLE' })
      : modelLookupError(error)
  }
  const marketRef = await registerModel(pool, model, owner)
  if (expected?.marketRef !== undefined && marketRef !== BigInt(expected.marketRef)) {
    throw new HfLaunchError(HF_MODEL_MOVED, { status: 409, code: 'HF_MODEL_MOVED' })
  }
  return modelRepository(marketRef, model, owner)
}

// The repositories row of a model market (db: a drizzle database). source and hf_model_ref are written once and never
// updated (repositories_source_range). Stars and forks stay 0: Hugging Face metrics never feed promotion
// (app/lib/repo-quality.mjs), rewards or anything else that could pay for metric manipulation.
export async function persistModelRepository(db, repo) {
  const marketRef = assertHfMarketId(repo.githubRepoId)
  const fields = { owner: repo.owner, name: repo.name, fullName: repo.fullName, description: repo.description,
    avatarUrl: repo.avatarUrl, githubUpdatedAt: new Date(repo.updatedAt ?? Date.now()) }
  await db.insert(repositories).values({ githubRepoId: marketRef, ...fields, stars: 0, forks: 0, archived: false,
    githubCreatedAt: repo.createdAt ? new Date(repo.createdAt) : null, source: 'huggingface', hfModelRef: marketRef })
    .onConflictDoUpdate({ target: repositories.githubRepoId, set: { ...fields,
      githubCreatedAt: sql`coalesce(excluded.github_created_at, ${repositories.githubCreatedAt})`, syncedAt: new Date() } })
}

// The launch coordinator's source for model markets (src/launch-coordinator.mjs). expected: { hfId, marketRef } of the
// model under review; the path is then only where to find it.
export function hfLaunchSource({ pool, hf, expected = null, enabled = hfMarketsEnabled }) {
  return {
    kind: 'huggingface',
    async resolve(input) {
      if (!enabled()) throw new HfLaunchError(HF_MARKETS_UNAVAILABLE, { status: 404, code: 'HF_MARKETS_UNAVAILABLE' })
      return resolveModel({ pool, hf, input, expected })
    },
    persist: persistModelRepository,
  }
}

// launchGuard for model markets, run by the coordinator at 'prepare' (market prepared, nothing signed) and at 'submit' (the
// wallet signed, nothing sent). Each time: the flag is on, the registry path still names the same _id, the model is public
// and enabled (hf.model() refuses both), and its owner has not opted it out. Any failure releases the market as 'failed'.
export function hfLaunchGuard({ pool, hf, enabled = hfMarketsEnabled }) {
  return async ({ market }) => {
    if (!enabled()) throw new HfLaunchError(HF_MARKETS_UNAVAILABLE, { status: 404, code: 'HF_MARKETS_UNAVAILABLE' })
    const marketRef = assertHfMarketId(market.githubRepoId)
    const registered = await registeredModel(pool, marketRef)
    if (!registered) throw new HfLaunchError('This model is not registered on repo.ing.', { status: 409, code: 'HF_NOT_REGISTERED' })
    let model
    try { model = await hf.model({ path: registered.repoPath }) } catch (error) { throw modelLookupError(error) }
    if (model.hfId !== registered.hfId) throw new HfLaunchError(HF_MODEL_MOVED, { status: 409, code: 'HF_MODEL_MOVED' })
    if (await activeDecision(pool, marketRef.toString())) throw new HfLaunchError(HF_OPT_OUT_ERROR, { status: 403, code: 'MAINTAINER_OPTED_OUT' })
  }
}
