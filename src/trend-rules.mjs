import { parseRepositoryUrl } from './github.mjs'

export const TREND_VERSION = 1
export const TREND_FRESH_MS = 6 * 60 * 60 * 1000
export const TREND_INTERVAL_MS = 30 * 60 * 1000
export const DAY = 86400000
export const TREND_STATES = ['detected', 'reviewed', 'approved', 'launched', 'active', 'rejected', 'duplicate']

export function repoLink(value) {
  return parseRepositoryUrl(value).normalizedUrl
}
export function assertTrendIdentity(repo, expectedId) {
  if (!Number.isSafeInteger(repo?.id) || repo.id < 1 || (expectedId && String(repo.id) !== String(expectedId)) ||
      typeof repo.full_name !== 'string' || repo.full_name !== `${repo.owner?.login}/${repo.name}` ||
      repoLink(`https://github.com/${repo.full_name}`) !== `https://github.com/${repo.full_name}` ||
      repo.private !== false || (repo.visibility && repo.visibility !== 'public') || repo.archived || repo.disabled ||
      ![repo.stargazers_count, repo.forks_count].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('REPO_NOT_VERIFIED')
  return repo
}
export function assertFreshTrend(candidate, now = Date.now()) {
  const time = Date.parse(candidate.observedAt)
  if (candidate.error || !Number.isFinite(time) || time > now + 60000 || now - time > TREND_FRESH_MS) throw Error(candidate.error || 'STALE_TREND_DATA')
}
export function transitionTrend(from, to) {
  const edges = { detected: ['reviewed','rejected','duplicate'], reviewed: ['approved','rejected','duplicate'],
    approved: ['reviewed','rejected','duplicate','launched'], launched: ['active'], active: [], rejected: ['reviewed'], duplicate: ['reviewed'] }
  if (!edges[from]?.includes(to)) throw Error('INVALID_REVIEW_TRANSITION')
  return to
}
export function observationVelocity(current, prior, key) {
  if (!current || !prior) return null
  const elapsed = Date.parse(current.observedAt) - Date.parse(prior.observedAt)
  if (elapsed < 3600000 || elapsed > 2 * DAY) return null
  const delta = current[key] - prior[key]
  if (!Number.isSafeInteger(delta)) return null
  return { delta, hours: elapsed / 3600000, perDay: delta * DAY / elapsed, from: prior.observedAt, to: current.observedAt }
}
// Versioned, deterministic sorting only. Unknown inputs earn no points; never
// substitute total stars or invented historical samples for measured velocity.
export function trendScore(observations, signals, now = Date.now()) {
  const [current] = observations
  const prior = observations.find(o => Date.parse(o.observedAt) <= Date.parse(current?.observedAt) - 3600000)
  const older = prior && observations.find(o => Date.parse(o.observedAt) <= Date.parse(prior.observedAt) - 3600000)
  const stars = observationVelocity(current, prior, 'stars'), forks = observationVelocity(current, prior, 'forks')
  const oldStars = observationVelocity(prior, older, 'stars')
  const recent = signals.filter(s => Date.parse(s.expiresAt) > now && Date.parse(s.occurredAt) <= now + 60000)
  const mentions = new Set(recent.filter(s => s.source === 'hn').map(s => s.url)).size
  const releaseAge = now - Date.parse(current?.releaseAt)
  const activity = current?.activity
  const parts = {
    stars: stars ? Math.min(25, Math.floor(Math.max(0, stars.perDay) / 10)) : 0,
    starAcceleration: stars && oldStars && stars.delta >= 10 && stars.perDay >= Math.max(1, oldStars.perDay) * 2 ? 10 : 0,
    forks: forks ? Math.min(15, Math.floor(Math.max(0, forks.perDay))) : 0,
    contributors: activity?.complete ? Math.min(10, Math.max(0, activity.currentContributors - activity.previousContributors) * 2) : 0,
    activity: activity?.complete && activity.currentCommits >= 5 && activity.currentCommits >= Math.max(1, activity.previousCommits) * 2 ? 5 : 0,
    release: releaseAge >= 0 && releaseAge <= 7 * DAY ? 10 : 0,
    mentions: Math.min(15, mentions * 5),
    trending: recent.some(s => s.source === 'github_trending') ? 10 : 0,
  }
  return { version: TREND_VERSION, total: Object.values(parts).reduce((a,b) => a+b,0), parts,
    inputs: { stars, forks, previousStars: oldStars, releaseAt: current?.releaseAt ?? null,
      activity: activity ?? null, mentions, trending: parts.trending > 0, manualSignals: recent.filter(s => s.source === 'manual').length },
    warmingUp: !stars || !forks }
}

export function commitActivity(commits, complete, now = Date.now()) {
  if (!complete || !Array.isArray(commits)) return { complete: false }
  const groups = [[], []]
  for (const c of commits) {
    const age = now - Date.parse(c.commit?.committer?.date)
    if (age >= 0 && age < 2 * DAY) groups[age < DAY ? 0 : 1].push(c)
  }
  const people = list => new Set(list.map(c => c.author?.id).filter(Number.isSafeInteger)).size
  return { complete: true, currentCommits: groups[0].length, previousCommits: groups[1].length,
    currentContributors: people(groups[0]), previousContributors: people(groups[1]),
    from: new Date(now - 2*DAY).toISOString(), to: new Date(now).toISOString() }
}

export function manualSignal({ repositoryUrl, sourceUrl, note, occurredAt }, now = Date.now()) {
  const repository = repoLink(repositoryUrl), url = new URL(sourceUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['x.com','twitter.com','news.ycombinator.com','github.com'].includes(url.hostname) ||
      typeof note !== 'string' || note.trim().length < 5 || note.length > 500) throw Error('INVALID_SOURCE_EVIDENCE')
  const time = Date.parse(occurredAt)
  if (!Number.isFinite(time) || time > now || time < now - 7*DAY) throw Error('STALE_SOURCE_EVIDENCE')
  return { repository, source: 'manual', url: url.href, note: note.trim(), occurredAt: new Date(time).toISOString(),
    expiresAt: new Date(time + 7*DAY).toISOString() }
}
