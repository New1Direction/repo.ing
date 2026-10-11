import { randomBytes } from 'node:crypto'
import { CreditsWebError, creditsCall, creditsServiceSettings, signInToCredits } from './credits-web.mjs'
import { builderClaimTicket } from './credits-tickets.mjs'
import { handoffSettings } from './repo-inference-handoff.mjs'
import { isGithubRepoId } from './market-identity.mjs'
import { takeQuota } from './request-quota.mjs'
// Never import src/credits-packs.mjs here: it imports this module (no cycle). The packs switch is read directly.

// Every pack pays a builder (docs/CREDITS_WEB.md, "Builder shares"; owner decision 2026-10-11): a pack opened for a repository
// sends 10% of its price to that repository's builders as AI credits, recorded by the credit ledger with the pack's spin and
// claimed by the repository's payout-wallet holder. repo.ing decides which repositories qualify and signs for it
// (src/credits-tickets.mjs). Dark unless CREDITS_WEB_BUILDER_SHARES_ENABLED is exactly 'true', with packs on.
export const BUILDER_SHARE_BPS = 1000
export function builderSharesSettings(env = process.env) {
  if (env.CREDITS_WEB_BUILDER_SHARES_ENABLED !== 'true' || env.CREDITS_WEB_PACKS_ENABLED !== 'true' || !creditsServiceSettings(env)) return null
  const handoff = handoffSettings(env)
  return handoff ? { secret: handoff.assertionSecret, shareBps: BUILDER_SHARE_BPS } : null
}
export const shareMicro = (packMicro, shareBps) => Math.floor(Number(packMicro) * shareBps / 10_000)

const TARGET_SQL = `select r.github_repo_id::text as "repoId", r.full_name as "fullName", r.source, m.status, m.indexed_at is not null as indexed,
    m.launch_finality as "launchFinality", m.quote_asset_id as "quoteAssetId", m.quote_mint as "quoteMint",
    b.github_user_id::text as holder,
    exists(select 1 from maintainer_opt_outs o where o.github_repo_id = r.github_repo_id and o.withdrawn_at is null) as declined
  from repositories r join markets m on m.github_repo_id = r.github_repo_id
  left join repo_beneficiaries b on b.github_repo_id = r.github_repo_id
  where r.github_repo_id = $1::bigint`
const refuse = message => { throw new CreditsWebError(message, 400) }

/** The one read behind every question about a repository's market here: its row, or null when it has none. A CreditsWebError (400) for an id that is not a GitHub repository id. */
export async function shareRepository(pool, repoId) {
  if (!/^[1-9]\d{0,18}$/.test(String(repoId ?? '')) || !isGithubRepoId(String(repoId))) refuse('Packs can back GitHub repositories only.')
  const { rows: [row] } = await pool.query(TARGET_SQL, [String(repoId)])
  return row ?? null
}
const hasLiveMarket = row => Boolean(row) && row.status === 'confirmed' && row.indexed && row.launchFinality === 'finalized'
/**
 * Whether a row from shareRepository is a confirmed, finalized GitHub market in SOL: the only kind with builder shares to ask the
 * credit service about. Not "may a pack back it" (builderShareTargetOf): the payout wallet holder's own repository and a declined one
 * have shares to show too.
 */
export const confirmedSolMarket = row => hasLiveMarket(row) && row.source === 'github' && !row.quoteAssetId && !row.quoteMint

/** The repository a pack may be opened for, from its row (shareRepository), or a CreditsWebError (400) saying why not. */
export function builderShareTargetOf(row, { buyerGithubUserId }) {
  if (!hasLiveMarket(row)) refuse('This repository has no market on repo.ing yet.')
  if (row.source !== 'github') refuse('Packs can back GitHub repositories only.')
  if (row.quoteAssetId || row.quoteMint) refuse('This is a stock pair: its builder share already goes to liquidity, so packs cannot back it.')
  if (row.declined) refuse('This repository’s maintainer opted out of repo.ing.')
  if (row.holder && row.holder === String(buyerGithubUserId)) refuse('You hold this repository’s payout wallet, so your own packs cannot pay it.')
  return { repoId: row.repoId, fullName: row.fullName }
}

/** The repository a pack may be opened for, or a CreditsWebError (400) saying why not. One read. */
export async function builderShareTarget(pool, { repoId, buyerGithubUserId }) {
  return builderShareTargetOf(await shareRepository(pool, repoId), { buyerGithubUserId })
}

const whole = value => Number.isSafeInteger(value) && value >= 0
/** A repository's builder shares so far, from the credit service: amounts only. */
export async function readShareTotals({ fetchImpl = fetch, settings, repoId }) {
  const value = await creditsCall(fetchImpl, settings.origin, `/builder-shares/${encodeURIComponent(repoId)}`)
  if (value.repo_id !== String(repoId) || !whole(value.packs) || !whole(value.paid_micro) || !whole(value.claimed_micro) || value.claimed_micro > value.paid_micro) {
    throw new CreditsWebError('The AI credits service returned invalid totals.', 502)
  }
  return { packs: value.packs, paidMicro: String(value.paid_micro), claimedMicro: String(value.claimed_micro), unclaimedMicro: String(value.paid_micro - value.claimed_micro) }
}

// Totals are public and anyone can ask for any repository: one credit service read per repository a minute, for at most 500
// repositories (the oldest entry goes first). An entry is the read itself, so callers waiting at the same time share it, and
// a failed read is dropped. Kept per process; a claim drops its repository's entry so the page shows what is left.
const TOTALS_SECONDS = 60, TOTALS_ENTRIES = 500
const totalsCache = new Map()
export function cachedShareTotals(settings, repoId, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const key = String(repoId), kept = totalsCache.get(key)
  if (kept && now() - kept.at < TOTALS_SECONDS * 1000) return kept.read
  const entry = { at: now(), read: readShareTotals({ fetchImpl, settings, repoId }) }
  totalsCache.delete(key)
  if (totalsCache.size >= TOTALS_ENTRIES) totalsCache.delete(totalsCache.keys().next().value)
  totalsCache.set(key, entry)
  entry.read.catch(() => { if (totalsCache.get(key) === entry) totalsCache.delete(key) })
  return entry.read
}

const forbid = message => { throw new CreditsWebError(message, 403) }
/**
 * Claims a repository's builder shares for the signed-in payout-wallet holder: their GitHub session for this repository, a
 * live admin check, the current payout binding, then an admin sign-in to the credit service and repo.ing's claim ticket.
 * Granted as AI credits on their repo.ing AI credits account. Only from a click. An answer of 0 is not "never paid": a replay
 * after a new sign-in answers 0 too, so the page says there is nothing new to claim.
 */
export async function claimPackShares({ pool, settings, shares, githubVerifier, session, repoId, fetchImpl = fetch, now = () => Date.now() }) {
  if (!session || String(session.repoId) !== String(repoId) || session.permission !== 'admin') forbid('Sign in with GitHub as an admin of this repository first.')
  const admin = await githubVerifier.verifyCurrentAuthority({ githubRepoId: String(repoId) }).catch(() => forbid('GitHub no longer lists you as an admin of this repository. Verify again.'))
  const { rows: [binding] } = await pool.query('select github_user_id::text as holder from repo_beneficiaries where github_repo_id=$1::bigint', [String(repoId)])
  if (!binding?.holder || binding.holder !== String(session.githubUserId)) forbid('Only the person who set this repository’s payout wallet can claim its pack shares.')
  if (!await takeQuota(pool, [[`credits:shares:${session.githubUserId}`, 5, 600]])) throw new CreditsWebError('Too many claims. Wait a few minutes.', 429)
  const login = admin.githubLogin ?? session.githubLogin
  const credits = await signInToCredits({ pool, settings, repoId: String(repoId), githubUserId: String(session.githubUserId), login, fetchImpl, now: now() })
  const idempotencyKey = randomBytes(16).toString('base64url')
  const ticket = builderClaimTicket(shares.secret, { idempotencyKey, githubUserId: String(session.githubUserId), repoId: String(repoId), issuedAt: new Date(now()).toISOString() })
  const result = await creditsCall(fetchImpl, settings.origin, '/builder-shares/claim', { method: 'POST', token: credits.token, idempotencyKey,
    body: { repo_id: String(repoId), ticket } })
  if (!whole(result.claimed_micro) || !whole(result.shares)) throw new CreditsWebError('The AI credits service returned an invalid claim.', 502)
  totalsCache.delete(String(repoId))
  return { claimedMicro: String(result.claimed_micro), shares: result.shares, session: credits }
}
