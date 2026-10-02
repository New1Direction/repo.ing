// Repository quality signals (server and client safe, no I/O). Markets keyed to repositories attract repositories made
// only to launch a coin, so market lists label new repositories, the token page and launch review show the facts, and
// repo.ing features a new repository's market (home lists, launch posts) only once it has earned it.
const DAY = 86_400_000

// New repo: GitHub created it less than NEW_REPO_DAYS ago, or it has fewer than NEW_REPO_MIN_STARS stars.
export const NEW_REPO_DAYS = 30
export const NEW_REPO_MIN_STARS = 10
// A new repository's market earns promotion once its bonding curve holds this percent of its graduation target, or graduates.
export const PROMOTION_MIN_PERCENT = 10
export const NEW_REPO_NOTE = `New repo — it won't be featured until it reaches ${PROMOTION_MIN_PERCENT}% of its graduation target.`

function createdTime(repo) {
  const value = repo?.githubCreatedAt
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : null
}

// Days since GitHub created the repository; null when unknown.
export function repoAgeDays(repo, now = Date.now()) {
  const created = createdTime(repo)
  return created === null ? null : (now - created) / DAY
}

// repo: { stars, githubCreatedAt }. An unknown creation date leaves the decision to stars; missing or malformed stars
// count as new, so a repository is never featured by mistake.
export function isNewRepo(repo, now = Date.now()) {
  if (!Number.isSafeInteger(repo?.stars) || repo.stars < NEW_REPO_MIN_STARS) return true
  const age = repoAgeDays(repo, now)
  return age !== null && age < NEW_REPO_DAYS
}

// market: { stars, githubCreatedAt, bondingPercent, graduated } — bondingPercent is the fresh, verified curve progress
// (null when stale or unknown, which never counts).
export function hasEarnedPromotion(market, now = Date.now()) {
  if (market?.graduated === true || !isNewRepo(market, now)) return true
  const progress = market?.bondingPercent
  return typeof progress === 'number' && Number.isFinite(progress) && progress >= PROMOTION_MIN_PERCENT
}

// Home featured lists keep only market rows that earned promotion (listMarkets sets `promoted` per row).
export const featuredMarkets = markets => markets.filter(market => market.promoted === true)

// Graduation race rows carry no repository facts: keep the racers whose market row earned promotion.
export function featuredRacers(race, markets) {
  const featured = new Set(featuredMarkets(markets).map(market => market.mint))
  return race.filter(racer => featured.has(racer.mint))
}

// Live-from-GitHub ticker items (selectTicker in dev-pulse.mjs) link to their token page: keep those of markets that earned
// promotion, in the given order.
export function featuredTicker(items, markets, limit = 14) {
  const featured = new Set(featuredMarkets(markets).map(market => `/token/${market.mint}`))
  return items.filter(item => featured.has(item.href)).slice(0, limit)
}

// Repo score, 0–100: four capped parts that simply add up, so the number explains itself.
//   stars     up to 40  log scale, full at 10,000 stars (100 stars ≈ 20)
//   forks     up to 15  log scale, full at 1,000 forks
//   age       up to 20  linear, full at two years
//   activity  up to 25  Dev Pulse, last 7 days: 5 per active developer (bots excluded, up to 15) and 1 per commit (up to 10);
//                       0 when Dev Pulse has no data for the repository
export const REPO_SCORE_MAX = Object.freeze({ stars: 40, forks: 15, age: 20, activity: 25 })
const logPoints = (value, full, max) => Number.isFinite(value) && value > 0 ? Math.min(max, max * Math.log10(1 + value) / Math.log10(1 + full)) : 0
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0

export function repoScore(repo, pulse = null, now = Date.now()) {
  const age = repoAgeDays(repo, now)
  const parts = {
    stars: Math.round(logPoints(repo?.stars, 10_000, REPO_SCORE_MAX.stars)),
    forks: Math.round(logPoints(repo?.forks, 1_000, REPO_SCORE_MAX.forks)),
    age: age === null || age <= 0 ? 0 : Math.round(Math.min(REPO_SCORE_MAX.age, REPO_SCORE_MAX.age * age / 730)),
    activity: Math.min(15, 5 * count(pulse?.devs7d)) + Math.min(10, count(pulse?.commits7d)),
  }
  return { score: parts.stars + parts.forks + parts.age + parts.activity, parts }
}

// '12 days', '5 months', '3 years' (floored); null when unknown.
export function repoAgeLabel(days) {
  if (days === null || !Number.isFinite(days) || days < 0) return null
  if (days < 1) return 'less than a day'
  const unit = (value, name) => `${value} ${name}${value === 1 ? '' : 's'}`
  if (days < 60) return unit(Math.floor(days), 'day')
  if (days < 730) return unit(Math.floor(days / 30.44), 'month')
  return unit(Math.floor(days / 365.25), 'year')
}

const plural = (value, name) => `${value.toLocaleString('en-US')} ${name}${value === 1 ? '' : 's'}`

// Display facts for the token page "Launch facts" row and launch review.
export function repoFactsView(repo, pulse = null, now = Date.now()) {
  const isNew = isNewRepo(repo, now), age = repoAgeLabel(repoAgeDays(repo, now))
  const stars = Number.isSafeInteger(repo?.stars) ? plural(repo.stars, 'star') : 'Stars unknown'
  const forks = Number.isSafeInteger(repo?.forks) ? plural(repo.forks, 'fork') : null
  const { score, parts } = repoScore(repo, pulse, now)
  return { isNew, tone: isNew ? 'warning' : 'neutral',
    title: isNew ? `New repo${age ? ` · ${age} old` : ''}` : age ? `Repo ${age} old` : 'Repo age unknown',
    age, stars, counts: [stars, forks].filter(Boolean).join(' · '), score,
    scoreLabel: `Repo score ${score}/100`,
    scoreDetail: `Stars ${parts.stars}/${REPO_SCORE_MAX.stars} · forks ${parts.forks}/${REPO_SCORE_MAX.forks} · age ${parts.age}/${REPO_SCORE_MAX.age} · activity ${parts.activity}/${REPO_SCORE_MAX.activity}` }
}

export const REPO_FACTS_TIP = `From GitHub. New repo: created in the last ${NEW_REPO_DAYS} days or fewer than ${NEW_REPO_MIN_STARS} stars; repo.ing doesn't feature `
  + `its market until it reaches ${PROMOTION_MIN_PERCENT}% of its graduation target. Repo score (0–100): stars up to 40, forks up to 15, `
  + 'age up to 20, and this week\'s developers and commits up to 25.'
