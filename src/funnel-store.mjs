import { GITHUB_REPO_ID_MAX } from './market-identity.mjs'
import { TEAM_REPO_IDS, TEAM_REPO_OWNERS } from './protocol-analytics.mjs'
import { funnelEvent } from '../app/lib/claim-funnel.mjs'

// Maintainer claim funnel events (funnel_events, migration 0070): written by POST /api/funnel and the GitHub sign-in
// routes, summarized for /operations/funnel. Each row is an event name, an optional source and outcome from fixed lists
// and an optional public repository id (app/lib/claim-funnel.mjs); nothing identifies a person. Rows older than
// retentionDays are deleted by the web service itself, at most once per pruneEveryMs per process.
export const FUNNEL_RETENTION_DAYS = 180
const PRUNE_EVERY_MS = 60 * 60 * 1000

export const FUNNEL_SUMMARY_SQL = `select event, outcome, source,
    count(*) filter (where created_at >= now() - interval '24 hours')::int as day,
    count(*) filter (where created_at >= now() - interval '7 days')::int as week,
    count(*)::int as month
  from funnel_events where created_at >= now() - interval '30 days'
  group by event, outcome, source order by event, outcome, source`

// The claim funnel from the ledgers themselves, for canonical GitHub SOL markets that have earned builder fees: how many
// had a GitHub admin verify, have a payout wallet, and have been paid, with SOL earned, paid and still waiting for a
// maintainer (no verification and no payout wallet: the /waiting definition). Split outside builders / team repos
// exactly as /stats does (src/protocol-analytics.mjs).
export const LEDGER_FUNNEL_SQL = `with repos as (
    select m.github_repo_id, (lower(r.owner) = any($1::text[]) or m.github_repo_id = any($2::bigint[])) as team,
      coalesce(f.earned, 0) as earned, coalesce(c.paid, 0) as paid,
      coalesce(w.collected, 0) as collected,
      exists (select 1 from repo_verifications v where v.github_repo_id = m.github_repo_id and v.permission = 'admin') as verified,
      exists (select 1 from repo_beneficiaries b where b.github_repo_id = m.github_repo_id) as wallet
    from markets m join repositories r on r.github_repo_id = m.github_repo_id
    left join (select github_repo_id, sum(amount_base_units) as earned from builder_fee_credits group by 1) f on f.github_repo_id = m.github_repo_id
    left join (select github_repo_id, sum(amount_base_units) as paid from repo_claims where status = 'settled' group by 1) c on c.github_repo_id = m.github_repo_id
    left join (select github_repo_id, sum(amount) as collected from builder_fee_collections where status='settled' group by 1) w on w.github_repo_id=m.github_repo_id
    where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' and m.quote_asset_id is null
      and m.github_repo_id <= ${GITHUB_REPO_ID_MAX}
  )
  select team, count(*)::int as earning, count(*) filter (where verified)::int as verified, count(*) filter (where wallet)::int as wallet,
    count(*) filter (where paid > 0)::int as paid, sum(earned)::text as "earnedLamports", sum(paid)::text as "paidLamports",
    coalesce(sum(greatest(earned - paid - collected, 0)) filter (where not verified and not wallet), 0)::text as "waitingLamports",
    count(*) filter (where not verified and not wallet and earned > paid + collected)::int as waiting
  from repos where earned > 0 group by team order by team`

export function createFunnelStore(pool, { now = Date.now, retentionDays = FUNNEL_RETENTION_DAYS, pruneEveryMs = PRUNE_EVERY_MS, onPruneError = () => {} } = {}) {
  let nextPrune = 0
  async function prune() {
    const { rowCount } = await pool.query('delete from funnel_events where created_at < now() - make_interval(days => $1)', [retentionDays])
    return rowCount
  }
  return {
    // One event, already checked by parseFunnelBeacon or funnelEvent.
    async record({ event, source = null, repoId = null, outcome = null }) {
      await pool.query('insert into funnel_events(event, source, repo_id, outcome) values ($1, $2, $3, $4)', [event, source, repoId, outcome])
      if (now() >= nextPrune) {
        nextPrune = now() + pruneEveryMs
        prune().catch(onPruneError)
      }
    },
    prune,
    async summary() { return (await pool.query(FUNNEL_SUMMARY_SQL)).rows },
    async ledger() {
      const { rows } = await pool.query(LEDGER_FUNNEL_SQL, [TEAM_REPO_OWNERS.map(owner => owner.toLowerCase()), TEAM_REPO_IDS])
      const empty = { earning: 0, verified: 0, wallet: 0, paid: 0, waiting: 0, earnedLamports: '0', paidLamports: '0', waitingLamports: '0' }
      return { outside: rows.find(row => row.team === false) ?? empty, team: rows.find(row => row.team === true) ?? empty }
    },
  }
}

const shared = new WeakMap()
// One store per pool per process, so pruning runs at most once an hour however many routes record.
export function funnelStore(pool) {
  if (!shared.has(pool)) shared.set(pool, createFunnelStore(pool, { onPruneError: () => console.warn('funnel_events_prune_failed') }))
  return shared.get(pool)
}

// Server events, best effort: a malformed event or a failed write never changes what the visitor sees.
export async function recordFunnelEvent(pool, event) {
  if (!pool) return false
  try { await funnelStore(pool).record(funnelEvent(event)); return true } catch { return false }
}
