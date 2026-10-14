// Display-only clock. Reaching a timestamp never proves that a launch happened.
export function launchWindow(schedule, now) {
  if (schedule.cancelledAt || schedule.state === 'cancelled') return { state: 'cancelled', label: 'Schedule cancelled', remaining: null }
  if (schedule.launchedMint || schedule.state === 'launched') return { state: 'launched', label: 'Launch recorded', remaining: null }
  const start = Date.parse(schedule.scheduledAt), end = Date.parse(schedule.windowEndsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { state: 'unknown', label: 'Schedule unavailable', remaining: null }
  const state = now < start ? 'upcoming' : now < end ? 'open' : 'ended'
  const seconds = Math.max(0, Math.ceil(((state === 'upcoming' ? start : end) - now) / 1000))
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60
  return { state, label: { upcoming: 'Launch scheduled', open: 'Scheduled launch window open', ended: 'Scheduled window ended' }[state],
    remaining: state === 'ended' ? null : `${days ? `${days}d ` : ''}${hours}h ${minutes}m ${rest}s` }
}

// Shared scale for both sides of every depth row. Missing data is not zero liquidity.
export function depthScale(depth = []) {
  const known = value => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0
  const max = Math.max(1, ...depth.flatMap(row => [row.buyLamports, row.sellLamports]).filter(known).map(Number))
  return value => known(value) ? Number(value) / max * 100 : null
}
