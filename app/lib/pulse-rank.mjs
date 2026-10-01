// Dev Pulse on market lists (server and client safe): each repository's shipping week, the badge in market rows, the
// "Shipping" order on Explore and the home "Shipping hardest this week" picks. Data: loadPulseIndex (dev-pulse.mjs).
const DAY = 86_400_000
const BOT = /(\[bot\]$|^(dependabot|renovate|github-actions|pre-commit-ci|greenkeeper|snyk-bot|mergify)\b)/i

export const isBotAuthor = name => !name || BOT.test(String(name).trim())

// Distinct human authors of commits and merged pull requests (GitHub login, or the git name when unlinked).
export function activeDevelopers(events) {
  return new Set(events.filter(event => ['commit', 'merge'].includes(event.kind) && !isBotAuthor(event.detail))
    .map(event => String(event.detail).trim().toLowerCase())).size
}

// Code that landed this week: each commit and merged pull request counts once, a release counts three.
export const pulseScore = pulse => pulse ? pulse.commits7d + pulse.merged7d + 3 * pulse.releases7d : -1

export function pulseListStatus(pulse, now = Date.now()) {
  const last = Date.parse(pulse?.lastCodeAt)
  if (!Number.isFinite(last)) return null
  return now - last < DAY ? 'shipping' : now - last < 7 * DAY ? 'active' : null
}

export function pulseBadge(pulse, now = Date.now()) {
  const status = pulseListStatus(pulse, now)
  if (!status) return null
  const commits = pulse.commits24h
  const text = status === 'active' ? 'Active this week' : commits ? `${commits} commit${commits === 1 ? '' : 's'} today` : 'Shipped today'
  const devs = pulse.devs7d ? ` · ${pulse.devs7d} developer${pulse.devs7d === 1 ? '' : 's'}` : ''
  return { status, text, title: `Last 7 days: ${pulse.commits7d} commits, ${pulse.merged7d} merged pull requests, ${pulse.releases7d} releases${devs}` }
}

const volume = market => BigInt(market.volume24hLamports ?? '0')
// Most code shipped this week first, then more developers, then 24h volume; repositories without a pulse go last.
export function orderByShipping(markets) {
  return [...markets].sort((a, b) => pulseScore(b.pulse) - pulseScore(a.pulse) || (b.pulse?.devs7d ?? 0) - (a.pulse?.devs7d ?? 0)
    || (volume(b) > volume(a) ? 1 : volume(b) < volume(a) ? -1 : 0))
}

export function shippingLeaders(markets, { excluded = new Set(), skipMints = [], limit = 3 } = {}) {
  return orderByShipping(markets.filter(market => pulseScore(market.pulse) > 0 && !excluded.has(String(market.repoId)) && !skipMints.includes(market.mint)))
    .slice(0, limit)
}
