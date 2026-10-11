import { CreditsWebError, creditsServiceSettings } from './credits-web.mjs'
import { handoffSettings } from './repo-inference-handoff.mjs'
import { isGithubRepoId } from './market-identity.mjs'
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

/** The repository a pack may be opened for, or a CreditsWebError (400) saying why not. One read. */
export async function builderShareTarget(pool, { repoId, buyerGithubUserId }) {
  if (!/^[1-9]\d{0,18}$/.test(String(repoId ?? '')) || !isGithubRepoId(String(repoId))) refuse('Packs can back GitHub repositories only.')
  const { rows: [row] } = await pool.query(TARGET_SQL, [String(repoId)])
  if (!row || row.status !== 'confirmed' || !row.indexed || row.launchFinality !== 'finalized') refuse('This repository has no market on repo.ing yet.')
  if (row.source !== 'github') refuse('Packs can back GitHub repositories only.')
  if (row.quoteAssetId || row.quoteMint) refuse('This is a stock pair: its builder share already goes to liquidity, so packs cannot back it.')
  if (row.declined) refuse('This repository’s maintainer opted out of repo.ing.')
  if (row.holder && row.holder === String(buyerGithubUserId)) refuse('You hold this repository’s payout wallet, so your own packs cannot pay it.')
  return { repoId: row.repoId, fullName: row.fullName }
}
