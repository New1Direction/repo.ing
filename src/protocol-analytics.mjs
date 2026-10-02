import { platformRevenueSummary, reconcilePlatformRevenue } from './platform-revenue.mjs'
import { liquidityReserveSummary, reconcileLiquidity } from './liquidity-deployment.mjs'

export const ANALYTICS_RANGES = ['24h', '7d', '30d', 'all']
export function analyticsWindow(range = 'all', now = new Date()) {
  const selected = ANALYTICS_RANGES.includes(range) ? range : 'all'
  const until = new Date(now), days = selected === '24h' ? 1 : selected === '7d' ? 7 : 30
  if (!Number.isFinite(until.getTime())) throw Error('INVALID_ANALYTICS_TIME')
  const since = selected === 'all' ? null : new Date(until.getTime() - days * 86400000)
  const chartSince = since ?? new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate() - 13))
  return { range: selected, until: until.toISOString(), since: since?.toISOString() ?? null, chartSince: chartSince.toISOString(), bucket: selected === '24h' ? 'hour' : 'day' }
}

// Team repos: the repo.ing team's own repositories, repo.ing itself included. They earn builder fees like any market; /stats
// reports them apart from outside builders so nobody mistakes the team paying itself for open source maintainers getting
// paid, and the totals still include both. A repository is a team repo when its GitHub owner is in TEAM_REPO_OWNERS or its
// GitHub repository id is in TEAM_REPO_IDS. Ids never change, so a renamed organization or a transferred repository keeps
// its history in the team column; the owner match covers team repositories launched after this list was written.
export const TEAM_REPO_OWNERS = Object.freeze(['New1Direction'])
// New1Direction/repo.ing, webmcp-anything, ohiyo and OntologyEX.
export const TEAM_REPO_IDS = Object.freeze(['1388219884', '1250482335', '1269625283', '1266706783'])
const TEAM_OWNERS = TEAM_REPO_OWNERS.map(owner => owner.toLowerCase())

// Existing finalized event ledgers only. The union cannot count deposits, LP
// migrations, claims or synthetic launch rows as trading volume. Every event carries
// whether its market's repository is a team repo; owners and ids are the query's
// parameters holding the lowercased TEAM_REPO_OWNERS (GitHub logins are
// case-insensitive) and TEAM_REPO_IDS.
const eventsSQL = (owners, ids) => `with canonical as (
  select m.*, (lower(r.owner) = any(${owners}::text[]) or m.github_repo_id = any(${ids}::bigint[])) as team
  from markets m join repositories r on r.github_repo_id=m.github_repo_id
  where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'
), events as (
  select 'volume' kind,t.traded_at occurred_at,(case when t.direction='buy' then t.input_base_units else t.output_base_units end)::numeric amount,m.team
    from trade_events t join canonical m on m.pool=t.pool
  union all select 'volume',t.traded_at,t.quote_amount,m.team from damm_trade_events t
    join canonical m on m.github_repo_id=t.github_repo_id join graduation_events g on g.github_repo_id=m.github_repo_id and g.pool=t.pool
  union all select 'earned',f.created_at,f.amount_base_units,m.team from fee_events f
    join canonical m on m.github_repo_id=f.github_repo_id and m.pool=f.pool
  union all select 'earned',f.created_at,f.amount_base_units,m.team from damm_fee_events f
    join canonical m on m.github_repo_id=f.github_repo_id join graduation_events g on g.github_repo_id=m.github_repo_id and g.pool=f.pool
  union all select 'paid',c.settled_at,c.amount_base_units,m.team from repo_claims c
    join canonical m on m.github_repo_id=c.github_repo_id where c.status='settled' and c.settled_at is not null
)`

export async function readProtocolAnalytics(pool, { range = 'all', now = new Date() } = {}) {
  const window = analyticsWindow(range, now), db = await pool.connect()
  try {
    await db.query('begin isolation level repeatable read read only')
    await db.query("set local statement_timeout='5000ms'")
    const { rows: [{ outside_earned, team_earned, outside_paid, team_paid, ...totals }] } = await db.query(`${eventsSQL('$3', '$4')}
      select coalesce(sum(amount) filter(where kind='volume'),0)::text as volume,
        coalesce(sum(amount) filter(where kind='earned'),0)::text as earned,
        coalesce(sum(amount) filter(where kind='paid'),0)::text as paid,
        count(*) filter(where kind='volume')::int as trades,
        (select count(*)::int from canonical) as markets,
        (select count(*)::int from graduation_events g join canonical m on m.github_repo_id=g.github_repo_id) as graduated,
        coalesce(sum(amount) filter(where kind='earned' and not team),0)::text as outside_earned,
        coalesce(sum(amount) filter(where kind='earned' and team),0)::text as team_earned,
        coalesce(sum(amount) filter(where kind='paid' and not team),0)::text as outside_paid,
        coalesce(sum(amount) filter(where kind='paid' and team),0)::text as team_paid
      from events where ($1::timestamptz is null or occurred_at >= $1) and occurred_at <= $2`, [window.since, window.until, TEAM_OWNERS, TEAM_REPO_IDS])
    const { rows: days } = await db.query(`${eventsSQL('$4', '$5')}, buckets as (
      select generate_series(date_trunc($3,$1::timestamptz at time zone 'UTC') at time zone 'UTC',
        date_trunc($3,$2::timestamptz at time zone 'UTC') at time zone 'UTC',case when $3='hour' then interval '1 hour' else interval '1 day' end) bucket
    ), grouped as (
      select date_trunc($3,occurred_at at time zone 'UTC') at time zone 'UTC' bucket,
        coalesce(sum(amount) filter(where kind='volume'),0)::text volume,
        coalesce(sum(amount) filter(where kind='earned'),0)::text earned,
        coalesce(sum(amount) filter(where kind='paid'),0)::text paid
      from events where occurred_at >= $1 and occurred_at <= $2 group by 1
    ) select b.bucket,coalesce(g.volume,'0') volume,coalesce(g.earned,'0') earned,coalesce(g.paid,'0') paid
      from buckets b left join grouped g using(bucket) order by b.bucket`, [window.chartSince, window.until, window.bucket, TEAM_OWNERS, TEAM_REPO_IDS])
    const { rows: payouts } = await db.query(`select r.full_name as "fullName",m.mint,c.amount_base_units::text as amount,
      c.claim_signature as signature,c.settled_at as "settledAt" from repo_claims c
      join markets m on m.github_repo_id=c.github_repo_id join repositories r on r.github_repo_id=m.github_repo_id
      where c.status='settled' and m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'
      and ($1::timestamptz is null or c.settled_at >= $1) and c.settled_at <= $2 order by c.settled_at desc,c.id desc limit 10`, [window.since, window.until])
    const revenue = await platformRevenueSummary(db), revenueCheck = await reconcilePlatformRevenue(db)
    const liquidity = await liquidityReserveSummary(db), liquidityCheck = await reconcileLiquidity(db)
    const { rows: [buybacks] } = await db.query("select count(*)::int n from buyback_intents where status='settled'")
    const { rows: receivers } = await db.query("select distinct wallet from platform_fee_claims where status='settled' order by wallet")
    await db.query('commit')
    const verified = revenueCheck.status === 'MATCH' && liquidityCheck.status === 'MATCH'
    return { ...window, updatedAt: window.until, totals, days: days.map(d => ({ ...d, bucket: d.bucket.toISOString() })), payouts,
      builders: { earned: { outside: outside_earned, team: team_earned }, paid: { outside: outside_paid, team: team_paid } },
      platform: { status: verified ? 'MATCH' : 'REVIEW', policy: revenue.activePolicy,
        ...(verified ? { claimed: revenue.claimed.total, unallocated: revenue.available, buybackReserve: revenue.buybackReserve,
          liquidityReserve: liquidity.remaining, liquidityAdded: liquidity.settled, treasuryAllocated: revenue.allocated.treasury,
          buybackSpent: revenue.spent, buybacks: buybacks.n, custodyWallets: receivers.map(row => row.wallet) } : {}) } }
  } catch (error) { await db.query('rollback'); throw error } finally { db.release() }
}
