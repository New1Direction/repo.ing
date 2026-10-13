import { database } from './server.mjs'
import { promotionExclusions } from './promotion-exclusions.mjs'
import { ttlMemo } from './ttl-memo.mjs'
import { launchCalendar, parseFeedQuery, readFeedEvents } from '../../src/launch-feed.mjs'

// The public launch calendar (/launches, /api/v1/launches, /launches.ics) shared for 30 s per process. Repositories repo.ing must
// not promote are left out, as in launch alerts; when that list cannot be read the calendar is unavailable rather than risk it.
const CALENDAR_TTL_MS = 30_000
export const calendar = ttlMemo(async () => {
  const pool = database()
  if (!pool) return { unavailable: 'Database is not configured.' }
  try {
    const excluded = await promotionExclusions(pool)
    return await launchCalendar(pool, { excluded })
  } catch (error) {
    console.error('launch calendar unavailable', { error: error?.message })
    return { unavailable: 'The launch calendar is temporarily unavailable.' }
  }
}, CALENDAR_TTL_MS, { keep: result => !result.unavailable })

// Feed events for the JSON API and the Atom feed. Throws a 400-worthy Error for a bad query.
export async function feedEvents(searchParams) {
  const query = parseFeedQuery(searchParams)
  const pool = database()
  if (!pool) throw Object.assign(new Error('Database is not configured.'), { status: 503 })
  return readFeedEvents(pool, query)
}

// The market-maker board (/api/v1/liquidity): every SOL market's latest liquidity sample with its 30-day uptime and medians, and
// for graduated pools the LP incentive preview from the stored report.
const BOARD_TTL_MS = 30_000
export const liquidityBoard = ttlMemo(async () => {
  const pool = database()
  if (!pool) return { unavailable: 'Database is not configured.' }
  try {
    const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.token_symbol as symbol, r.full_name as "fullName",
        s.sampled_at as "sampledAt", s.venue, s.pool, s.fee_bps as "feeBps", s.quote_reserve_lamports::text as "quoteReserveLamports",
        s.buy_depth_lamports::text as "buyDepthLamports", s.sell_depth_lamports::text as "sellDepthLamports", s.spread_bps as "spreadBps", s.two_sided as "twoSided",
        q.report->'health'->'liquidity' as "sustained", q.report->'incentives' as incentives
      from markets m join repositories r on r.github_repo_id = m.github_repo_id
      join lateral (select * from market_liquidity_samples x where x.github_repo_id = m.github_repo_id order by x.sampled_at desc limit 1) s on true
      left join launch_quality_reports q on q.github_repo_id = m.github_repo_id
      where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' and m.quote_asset_id is null
      order by s.buy_depth_lamports + s.sell_depth_lamports desc, m.github_repo_id limit 500`)
    return { generatedAt: new Date().toISOString(), markets: rows.map(row => ({ ...row, sampledAt: row.sampledAt?.toISOString?.() ?? row.sampledAt })) }
  } catch (error) {
    if (error?.code === '42P01') return { generatedAt: new Date().toISOString(), markets: [] }
    console.error('liquidity board unavailable', { error: error?.message })
    return { unavailable: 'Liquidity data is temporarily unavailable.' }
  }
}, BOARD_TTL_MS, { keep: result => !result.unavailable })

