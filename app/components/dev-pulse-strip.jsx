import { formatCount, pulseAgo, pulseStatusLabel, starsToday } from '../lib/pulse-format.mjs'

const RECENT = 14 * 86_400_000

// One line under the token hero: is the dev shipping? Links down to the Dev Pulse card. Nothing until GitHub was read.
export function DevPulseStrip({ pulse, now = Date.now() }) {
  if (!['shipping', 'active', 'quiet'].includes(pulse?.status)) return null
  const today = starsToday(pulse.stars)
  const facts = [
    pulse.commits24h > 0 ? `${formatCount(pulse.commits24h)} commit${pulse.commits24h === 1 ? '' : 's'} today`
      : pulse.commits7d > 0 ? `${formatCount(pulse.commits7d)} commit${pulse.commits7d === 1 ? '' : 's'} this week` : null,
    pulse.release && now - Date.parse(pulse.release.at) < RECENT ? `${pulse.release.title} · ${pulseAgo(pulse.release.at, now)}` : null,
    today && pulse.stars.today > 0 ? `${today} stars today` : null,
    pulse.hn ? 'on Hacker News' : null,
  ].filter(Boolean).slice(0, 3)
  return <a className={`dev-pulse-strip is-${pulse.status}`} href="#dev-pulse"><i aria-hidden="true"/><strong>{pulseStatusLabel(pulse, now)}</strong>
    {facts.map(fact => <span key={fact}>{fact}</span>)}</a>
}
