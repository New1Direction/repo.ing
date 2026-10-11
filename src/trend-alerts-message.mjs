// "First to launch" alerts (see src/trend-alerts.mjs), pure parts: which trending repositories may be announced, and the
// post text. The trend pipeline (src/trend-launchable.mjs) already decided what is trending and launchable; this only
// keeps repositories whose measured star growth is strong enough to be worth a public post. Repository text is untrusted
// and cleaned like a launch post's (src/launch-alerts-message.mjs).
import { cleanDescription, cleanRepoName, escapeHtml, LINKABLE, truncate, X_MAX_WEIGHT, xWeight } from './launch-alerts-message.mjs'
import { launcherRewardTerms } from './trend-launchable.mjs'

// A measured window this short can turn a handful of stars into a large daily rate; require a real count too.
export const TREND_ALERT_MIN_STARS_GAINED = 25
const TELEGRAM_DESCRIPTION_CHARS = 200
// A shortened repository name keeps at least this many characters (with its …), or the post drops the reward line instead.
const MIN_NAME_CHARS = 16
export const TREND_ALERT_NOTE = 'Community launch, not endorsed by the maintainers.'

// Why a launchable trend (selectLaunchableTrends' item) must not be announced, or null when it may be.
// - no measured star growth, or growth below minStarsPerDay or below TREND_ALERT_MIN_STARS_GAINED stars;
// - a fork: whether a fork may launch is decided at launch (src/repo-lineage.mjs), so it is never invited publicly;
// - a repository first detected before the cutoff (detected_at never moves; observed_at does with every refresh): turning
//   the job on never announces what was already trending.
export function trendAlertExclusion(item, { since, minStarsPerDay }) {
  const gained = item.starsGained
  if (!gained || !Number.isSafeInteger(gained.delta) || !(gained.hours > 0)) return 'NO_STAR_GROWTH'
  if (gained.delta < TREND_ALERT_MIN_STARS_GAINED || !(gained.perDay >= minStarsPerDay)) return 'BELOW_THRESHOLD'
  if (item.forkOf) return 'FORK'
  if (!(Date.parse(item.detectedAt) >= since.getTime())) return 'BEFORE_SINCE'
  return null
}

// The trends this run may announce, in the pipeline's order (operator-reviewed first, then score).
export function trendAlertCandidates(items, options) {
  return items.filter(item => trendAlertExclusion(item, options) === null)
}

// The item's own launch path (/launch/<id>, with ?from=trend for an operator-approved trend: the attributed path).
export const launchUrl = (origin, post) => `${origin}${/^\/launch\/\d+(\?from=trend)?$/.test(post.launchHref ?? '') ? post.launchHref : `/launch/${encodeURIComponent(post.repoId)}`}`
// A description may name a site the repository's author controls; Telegram links bare domains, so none are kept.
const plainDescription = value => cleanDescription(value).replace(LINKABLE, ' ').replace(/\s+/gu, ' ').trim()

// The call to launch: with discovery rewards on, what the launch wallet earns and its limits, from the policy itself so
// the copy cannot drift; without them, the builders' share. X says "our" (the post is repo.ing's own; a domain weighs 23).
function call(reward, channel) {
  if (!reward) return "Launch it first. Every trade pays the repo's builders."
  const terms = launcherRewardTerms()
  return `Launch it first: its launch wallet earns ${terms.sharePercent}% of ${channel === 'x' ? 'our' : "repo.ing's"} trading fees until graduation, `
    + `${terms.windowDays} days or ${terms.capSol} SOL.`
}

// post: { repoId, fullName, description, launchHref, starsGained: { delta, hours } }. reward: whether discovery rewards are
// on (the worker's DISCOVERY_REWARDS_ENABLED). channel: 'telegram' (HTML) or 'x' (plain, at most 280 weighted characters;
// a long repository name is shortened visibly with …, never the reward's limits). Factual: measured stars, no price talk.
export function buildTrendMessage(post, { channel, origin, reward = false }) {
  const repo = cleanRepoName(post.fullName), url = launchUrl(origin, post)
  const stars = `+${post.starsGained.delta.toLocaleString('en-US')} GitHub stars in ${Math.max(1, Math.round(post.starsGained.hours))}h`
  const headline = name => `🔥 ${name}: ${stars}, no market yet.`
  if (channel === 'telegram') {
    const description = plainDescription(post.description)
    const about = description ? [truncate(description, text => text.length <= TELEGRAM_DESCRIPTION_CHARS)] : []
    return [headline(repo), ...about, call(reward, channel), TREND_ALERT_NOTE, url].map(escapeHtml).join('\n')
  }
  if (channel !== 'x') throw Error(`Unknown trend alert channel ${channel}`)
  const fits = value => xWeight(value) <= X_MAX_WEIGHT
  // A reward line that cannot fit next to a readable name is left out whole (never only its limits).
  for (const callText of [call(reward, channel), call(false, channel)]) {
    const text = name => [headline(name), callText, TREND_ALERT_NOTE, url].join('\n')
    if (fits(text(repo))) return text(repo)
    const name = truncate(repo, value => fits(text(value)))
    if ([...name].length >= MIN_NAME_CHARS) return text(name)
  }
  throw Error('Trend alert exceeds the X length limit')
}
