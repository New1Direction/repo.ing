import { NoteError, sanitizeNote } from './holder-notes.mjs'
import { isMarketId, marketSource } from './market-identity.mjs'

// Maintainer decisions (drizzle/0041_maintainer_opt_outs.sql). A current GitHub admin can decline a repository's market
// ('decline') or, while it has none, opt the repository out of repo.ing ('opt_out'). While a decision is active, repo.ing
// never promotes the repository (app/lib/promotion-exclusions.mjs), its token page says the maintainer declined, and no
// new market can be launched for it. An existing market keeps trading so holders can exit, and its builder fees stay
// claimable by the verified maintainer exactly as before. Withdrawing restores normal behavior; old rows stay as history.
// Hugging Face models (drizzle/0050_model_opt_outs.sql) have the same two decisions, keyed by the model's registry market
// id (hf_models.market_ref) and made by its current owner or an admin of its organization (source 'huggingface').
export const OPT_OUT_ERROR = 'The maintainer has opted this repository out of repo.ing'
export const MODEL_OPT_OUT_ERROR = 'The model’s owner has opted it out of repo.ing'
export const DECISION_KINDS = Object.freeze(['decline', 'opt_out'])
const REPO_ID = /^[1-9]\d{0,18}$/
const SUBJECT = /^[0-9a-f]{24}$/

export class DecisionError extends Error {
  constructor(message, status = 400, code = null) { super(message); this.status = status; this.code = code }
}

const repoIdOf = value => {
  if (!REPO_ID.test(String(value ?? ''))) throw new DecisionError('Invalid repository.')
  return String(value)
}
const iso = value => value instanceof Date ? value.toISOString() : value
const decisionOf = row => row ? { repoId: row.repoId, kind: row.kind, note: row.note ?? null, createdAt: iso(row.createdAt) } : null

// The optional public note follows the holder-note rules: plain text, at most 280 characters, no links except github.com.
// Blank means no note.
export function decisionNote(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null
  try { return sanitizeNote(value) } catch (error) { throw new DecisionError(error instanceof NoteError ? error.message : 'Invalid note.') }
}

const ACTIVE = `select github_repo_id::text as "repoId", kind, note, created_at as "createdAt" from maintainer_opt_outs
  where withdrawn_at is null`

// Reads of maintainer_opt_outs only. A database the migration has not reached yet has no such table (42P01), so it holds
// no decisions; every other error still fails the caller.
async function readDecisions(pool, sql, params = []) {
  try { return (await pool.query(sql, params)).rows }
  catch (error) { if (error?.code === '42P01') return []; throw error }
}

export async function activeDecision(pool, repoId) {
  const [row] = await readDecisions(pool, `${ACTIVE} and github_repo_id = $1`, [repoIdOf(repoId)])
  return decisionOf(row)
}

// Repository id → active decision, for a list of repositories (the builder dashboard and /opt-out).
export async function activeDecisions(pool, repoIds) {
  const ids = repoIds.map(repoIdOf)
  if (!ids.length) return new Map()
  const rows = await readDecisions(pool, `${ACTIVE} and github_repo_id = any($1::bigint[])`, [ids])
  return new Map(rows.map(row => [row.repoId, decisionOf(row)]))
}

export async function activeOptOutRepoIds(pool) {
  const rows = await readDecisions(pool, 'select github_repo_id::text as "repoId" from maintainer_opt_outs where withdrawn_at is null')
  return rows.map(row => row.repoId)
}

// Every launch path (/api/resolve, /api/launch prepare, agent drafts) calls this for a repository without a market. A model
// launch passes the model's registry market id (a model repo.ing has never registered has no decision to find).
export async function assertLaunchAllowed(pool, repoId) {
  if (await activeDecision(pool, repoId)) {
    const model = isMarketId(repoId) && marketSource(repoId) === 'huggingface'
    throw new DecisionError(model ? MODEL_OPT_OUT_ERROR : OPT_OUT_ERROR, 403, 'MAINTAINER_OPTED_OUT')
  }
}

// The canonical public market, as the token and claim pages and the claim verifier define it.
export async function hasLiveMarket(pool, repoId) {
  const { rows } = await pool.query(`select 1 from markets where github_repo_id = $1 and status = 'confirmed'
    and indexed_at is not null and launch_finality = 'finalized'`, [repoIdOf(repoId)])
  return rows.length > 0
}

// verifyAdmin({ githubRepoId, live }) must freshly confirm the signed-in user's CURRENT GitHub admin permission for the
// repository (throwing otherwise) and return their { githubUserId }. live: whether the repository has a public market
// (the claim flow's verifier requires one; app/api/opt-out/route.js picks the check).
// source 'huggingface' (app/api/opt-out/hf/route.js): repoId is a model's registry market id, and verifyAdmin must freshly
// confirm the signed-in user is the model's current owner or an admin of its organization, returning their { subject }.
// An id of the other source is refused before anything is read.
export function createMaintainerDecisions({ pool, verifyAdmin, source = 'github' }) {
  const model = source === 'huggingface'
  const sourceOf = id => {
    if (!isMarketId(id) || marketSource(id) !== source) throw new DecisionError(model ? 'Invalid model.' : 'Invalid repository.')
    return id
  }
  async function authority(repoId) {
    const live = await hasLiveMarket(pool, repoId)
    let admin
    try { admin = await verifyAdmin({ githubRepoId: repoId, live }) }
    catch (error) { console.warn('maintainer_decision_unverified', { repoId, error: String(error?.message ?? error).slice(0, 120) }); admin = null }
    if (model) {
      if (!SUBJECT.test(String(admin?.subject ?? ''))) {
        throw new DecisionError('Only the model’s current owner on Hugging Face, or an admin of the organization that owns it, can do this. Sign in with Hugging Face again.', 403)
      }
      return { live, subject: admin.subject }
    }
    if (!/^[1-9]\d*$/.test(String(admin?.githubUserId ?? ''))) {
      throw new DecisionError('Only a current GitHub admin of this repository can do this. Reconnect GitHub and try again.', 403)
    }
    return { live, githubUserId: String(admin.githubUserId) }
  }
  const insertDecision = (id, kind, actor, text) => model
    ? pool.query(`insert into maintainer_opt_outs (github_repo_id, kind, github_user_id, note, authority_source, actor_subject)
        values ($1, $2, null, $3, 'huggingface', $4) returning github_repo_id::text as "repoId", kind, note, created_at as "createdAt"`, [id, kind, text, actor.subject])
    : pool.query(`insert into maintainer_opt_outs (github_repo_id, kind, github_user_id, note) values ($1, $2, $3, $4)
          returning github_repo_id::text as "repoId", kind, note, created_at as "createdAt"`, [id, kind, actor.githubUserId, text])
  return {
    // kind is what the maintainer confirmed on screen: 'decline' for a repository with a market, 'opt_out' without one.
    async create({ repoId, kind, note }) {
      const id = sourceOf(repoIdOf(repoId)), text = decisionNote(note)
      if (!DECISION_KINDS.includes(kind)) throw new DecisionError('Choose to decline the market or opt out.')
      const actor = await authority(id), { live } = actor
      const thing = model ? 'model' : 'repository'
      if ((kind === 'decline') !== live) {
        throw new DecisionError(live ? `This ${thing} has a market now. Refresh and review again.` : `This ${thing} has no market. Refresh and review again.`, 409)
      }
      try {
        const { rows } = await insertDecision(id, kind, actor, text)
        return decisionOf(rows[0])
      } catch (error) {
        if (error?.code !== '23505') throw error
        throw new DecisionError(live ? 'This market is already declined.' : `This ${thing} is already opted out.`, 409)
      }
    },
    async withdraw({ repoId }) {
      const id = sourceOf(repoIdOf(repoId))
      const actor = await authority(id)
      const { rows } = model
        ? await pool.query(`update maintainer_opt_outs set withdrawn_at = now(), withdrawn_by_subject = $2
            where github_repo_id = $1 and withdrawn_at is null returning withdrawn_at as "withdrawnAt"`, [id, actor.subject])
        : await pool.query(`update maintainer_opt_outs set withdrawn_at = now(), withdrawn_by_github_user_id = $2
        where github_repo_id = $1 and withdrawn_at is null returning withdrawn_at as "withdrawnAt"`, [id, actor.githubUserId])
      if (!rows.length) throw new DecisionError(`There is nothing to withdraw for this ${model ? 'model' : 'repository'}.`, 409)
      return { repoId: id, withdrawnAt: iso(rows[0].withdrawnAt) }
    },
  }
}
