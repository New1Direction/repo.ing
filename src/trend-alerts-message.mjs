// "First to launch" alerts (see src/trend-alerts.mjs), pure parts: which trending repositories may be announced, and the
// post text. The trend pipeline (src/trend-launchable.mjs) already decided what is trending and launchable; this only
// keeps repositories whose measured star growth is strong enough to be worth a public post. Repository text is untrusted
// and cleaned like a launch post's (src/launch-alerts-message.mjs).
import { cleanDescription, cleanRepoName, escapeHtml, truncate, X_MAX_WEIGHT, xWeight } from './launch-alerts-message.mjs'
import { launcherRewardTerms } from './trend-launchable.mjs'

// A measured window this short can turn a handful of stars into a large daily rate; require a real count too.
export const TREND_ALERT_MIN_STARS_GAINED = 25
const TELEGRAM_DESCRIPTION_CHARS = 200
export const TREND_ALERT_NOTE = 'Community launch, not endorsed by the maintainers.'

// Why a launchable trend (selectLaunchableTrends' item) must not be announced, or null when it may be.
// - no measured star growth, or growth below minStarsPerDay or below TREND_ALERT_MIN_STARS_GAINED stars;
// - a fork: whether a fork may launch is decided at launch (src/repo-lineage.mjs), so it is never invited publicly;
// - evidence observed before the cutoff: turning the job on never announces what was already trending.
export function trendAlertExclusion(item, { since, minStarsPerDay }) {
  const gained = item.starsGained
  if (!gained || !Number.isSafeInteger(gained.delta) || !(gained.hours > 0)) return 'NO_STAR_GROWTH'
  if (gained.delta < TREND_ALERT_MIN_STARS_GAINED || !(gained.perDay >= minStarsPerDay)) return 'BELOW_THRESHOLD'
  if (item.forkOf) return 'FORK'
  if (!(Date.parse(item.observedAt) >= since.getTime())) return 'BEFORE_SINCE'
  return null
}

// The trends this run may announce, in the pipeline's order (operator-reviewed first, then score).
export function trendAlertCandidates(items, options) {
  return items.filter(item => trendAlertExclusion(item, options) === null)
}

export const launchUrl = (origin, repoId) => `${origin}/launch/${encodeURIComponent(repoId)}`

// The call to launch: with discovery rewards on, what the launch wallet earns, from the policy itself so the copy cannot
// drift (the long form adds its limits); without them, the builders' share.
function calls(reward) {
  if (!reward) return ["Launch it first. Every trade pays the repo's builders."]
  const terms = launcherRewardTerms()
  const earns = `Launch it first: the launch wallet earns ${terms.sharePercent}% of repo.ing's trading fees`
  return [`${earns} until graduation, ${terms.windowDays} days or ${terms.capSol} SOL.`, `${earns}.`]
}

// post: { repoId, fullName, description, starsGained: { delta, hours } }. reward: whether discovery rewards are on (the
// worker's DISCOVERY_REWARDS_ENABLED). channel: 'telegram' (HTML) or 'x' (plain, at most 280 weighted characters; a long
// repository name first drops the reward's limits, then is shortened visibly with …). Factual: measured stars, no price talk.
export function buildTrendMessage(post, { channel, origin, reward = false }) {
  const repo = cleanRepoName(post.fullName), url = launchUrl(origin, post.repoId)
  const stars = `+${post.starsGained.delta.toLocaleString('en-US')} GitHub stars in ${Math.max(1, Math.round(post.starsGained.hours))}h`
  const headline = name => `🔥 ${name}: ${stars}, no market yet.`
  const [call, shortCall = call] = calls(reward)
  if (channel === 'telegram') {
    const description = cleanDescription(post.description)
    const about = description ? [truncate(description, text => text.length <= TELEGRAM_DESCRIPTION_CHARS)] : []
    return [headline(repo), ...about, call, TREND_ALERT_NOTE, url].map(escapeHtml).join('\n')
  }
  if (channel !== 'x') throw Error(`Unknown trend alert channel ${channel}`)
  const text = (name, callText) => [headline(name), callText, TREND_ALERT_NOTE, url].join('\n')
  const fits = value => xWeight(value) <= X_MAX_WEIGHT
  for (const callText of [call, shortCall]) if (fits(text(repo, callText))) return text(repo, callText)
  const name = truncate(repo, value => fits(text(value, shortCall)))
  if (!name) throw Error('Trend alert exceeds the X length limit')
  return text(name, shortCall)
}
