import { publicGraduation } from '../../src/graduation-readiness.mjs'
import { formatSolDisplay } from './format.mjs'
import { orderMarkets } from './market-order.mjs'
import { chartTradeAge } from './chart-display.mjs'
import { promotionExcludedRepoIds } from './promotion-exclusions.mjs'

// Home and /explore "Graduation race": curve markets ranked by verified progress toward their own graduation target.
export const GRADUATION_RACE_LIMIT = 5
// Floor: 1% of the market's own target, i.e. 0.85 / 1.7 / 3.4 SOL held in the curve for the 85 / 170 / 340 SOL
// configs. Percents are shown floored to whole numbers, so 1% is the first value that never reads as "0%"; being
// relative, it treats every target size alike (a flat SOL floor would let a 340 SOL market race at "0%").
export const GRADUATION_RACE_MIN_PERCENT = 1
// At or above this a racer is also marked "About to graduate" (the section this race replaced).
export const ABOUT_TO_GRADUATE_MIN_PERCENT = 50
// "Repo markets to watch" on the $REPOING page: the race's top three and the three newest launches.
export const WATCH_LIMIT = 3

const reached = (reserve, threshold, percent) => reserve * 100n >= threshold * BigInt(percent)

// rows: graduation_observations columns plus the migration evidence hash, with the market identity. Each row must pass
// the public curve endpoint's freshness and verification gate (publicGraduation); a row that throws (stale, unverified)
// is skipped, as are graduated and migrating markets and repositories on the do-not-promote list (excluded: a Set of
// GitHub repository ids). Ranked by exact reserve/threshold ratio, never a rounded percent.
export function rankGraduationRace(rows, { now = Date.now(), excluded = new Set() } = {}) {
  const racers = rows.flatMap(row => {
    if (excluded.has(String(row.repoId))) return []
    let curve
    try { curve = publicGraduation(row, now) } catch { return [] }
    if (curve.phase !== 'CURVE' || curve.status !== 'active') return []
    const reserve = BigInt(curve.reserveLamports), threshold = BigInt(curve.thresholdLamports)
    if (threshold <= 0n || !reached(reserve, threshold, GRADUATION_RACE_MIN_PERCENT)) return []
    const { repoId, mint, fullName, symbol, tokenName } = row
    return [{ repoId, mint, fullName, symbol, tokenName, progressPercent: curve.progressPercent, reserveLamports: curve.reserveLamports,
      thresholdLamports: curve.thresholdLamports, remainingLamports: curve.remainingLamports,
      aboutToGraduate: reached(reserve, threshold, ABOUT_TO_GRADUATE_MIN_PERCENT) }]
  })
  return racers.sort((a, b) => {
    const d = BigInt(b.reserveLamports) * BigInt(a.thresholdLamports) - BigInt(a.reserveLamports) * BigInt(b.thresholdLamports)
    return d > 0n ? 1 : d < 0n ? -1 : a.mint.localeCompare(b.mint)
  })
}

export function topOfRace(race, { limit = GRADUATION_RACE_LIMIT, excludeMints = [] } = {}) {
  const excluded = new Set(excludeMints)
  return race.filter(market => !excluded.has(market.mint)).slice(0, limit)
}

// One joined read of public markets with a VERIFIED observation; freshness is checked per row above. Repositories on
// the do-not-promote list (PROMOTION_EXCLUDED_REPO_IDS) never race.
export async function readGraduationRace(pool, { now = Date.now(), excluded = promotionExcludedRepoIds() } = {}) {
  const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.token_name as "tokenName",
      m.token_symbol as "symbol", r.full_name as "fullName", o.status, o.observation, o.error_code,
      e.evidence_hash as migration_evidence_hash
    from markets m join repositories r on r.github_repo_id = m.github_repo_id
    join graduation_observations o on o.github_repo_id = m.github_repo_id
    left join graduation_events e on e.github_repo_id = m.github_repo_id
    where m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' and o.status = 'VERIFIED'`)
  return rankGraduationRace(rows, { now, excluded })
}

// Newest launches from the memoized listMarkets() rows (already public, finalized markets only), newest first, without
// the given mints or any repository on the do-not-promote list.
export function newestLaunches(markets, { limit = WATCH_LIMIT, excludeMints = [], excluded = promotionExcludedRepoIds(), now = Date.now() } = {}) {
  const skipMints = new Set(excludeMints)
  const launchedAt = market => new Date(market.indexedAt).getTime()
  const shown = market => !skipMints.has(market.mint) && !excluded.has(String(market.repoId)) && Number.isFinite(launchedAt(market))
  return orderMarkets(markets.filter(shown), 'New').slice(0, limit)
    .map(market => ({ repoId: market.repoId, mint: market.mint, fullName: market.fullName, symbol: market.symbol,
      launched: chartTradeAge(new Date(launchedAt(market)).toISOString(), now) }))
}

// Floor so 99.9% never reads as 100% before the target is reached. Formats from raw lamports.
export const graduationPercentLabel = percent => `${Math.floor(percent)}%`
export const remainingLabel = market => `${formatSolDisplay(market.remainingLamports)} SOL to go`
export const graduationSummary = market => `${graduationPercentLabel(market.progressPercent)} · ${remainingLabel(market)}`
// Screen-reader name for a whole-row link (the bar inside it is decorative).
export const raceLabel = market => `${market.fullName} ($${market.symbol}): ${graduationSummary(market)}${market.aboutToGraduate ? ', about to graduate' : ''}`
