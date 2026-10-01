// Dev Pulse wording shared by the token page card, the hero strip and the home ticker (server and client safe).
const UNITS = [['d', 86_400], ['h', 3_600], ['m', 60]]

// '2h ago', '3d ago', 'just now'. Whole units, floored.
export function pulseAgo(at, now = Date.now()) {
  const seconds = Math.floor((now - Date.parse(at)) / 1000)
  if (!Number.isFinite(seconds)) return null
  for (const [unit, size] of UNITS) if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`
  return 'just now'
}

export function pulseStatusLabel(pulse, now = Date.now()) {
  if (pulse?.status === 'shipping') return 'Shipping now'
  if (pulse?.status === 'active') return 'Active this week'
  if (pulse?.status === 'quiet') return `Quiet · last activity ${pulseAgo(pulse.lastCodeAt, now)}`
  if (pulse?.status === 'none') return 'No recent public activity'
  return 'Checking GitHub…'
}

export const formatCount = value => Number(value ?? 0).toLocaleString('en-US')
// '+48' stars today; '+12+' while Dev Pulse has watched for less than a day; nothing when that partial count is still zero.
export const starsToday = stars => stars?.today == null || (stars.partial && !stars.today) ? null
  : `+${formatCount(stars.today)}${stars.partial ? '+' : ''}`

export const PULSE_KINDS = Object.freeze({
  release: 'Release', merge: 'Merged pull request', commits: 'Commits', stars: 'Stars', hn: 'Hacker News', verified: 'Maintainer verified', paid: 'Builder payout',
})
