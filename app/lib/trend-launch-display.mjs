// Labels for the "Launch a trending repo" list. Every figure is measured evidence with its window; no projections.
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const compactCount = value => COMPACT.format(value)

export function ageLabel(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

// Velocity spans 1h to 2 days between two observations; show the delta over the window actually measured.
export function starGrowth(gained) {
  return { value: `+${gained.delta.toLocaleString('en-US')}`, window: `stars in ${Math.max(1, Math.round(gained.hours))}h` }
}

export function trendSignals(repo, now = Date.now()) {
  return [
    repo.onGithubTrending && { key: 'trending', text: 'On GitHub Trending' },
    repo.hnStories === 1 && { key: 'hn', text: 'On Hacker News' },
    repo.hnStories > 1 && { key: 'hn', text: `${repo.hnStories} Hacker News stories` },
    repo.releasedAt && { key: 'release', text: `Released ${ageLabel(repo.releasedAt, now)}` },
  ].filter(Boolean)
}

export function rewardShort(terms) {
  return `Earn ${terms.sharePercent}% of repo.ing’s trading fees`
}

export function rewardLimits(terms) {
  return `until graduation, ${terms.windowDays} days, or ${terms.capSol} SOL earned—whichever comes first`
}
