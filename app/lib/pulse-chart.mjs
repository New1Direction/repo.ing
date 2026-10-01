// Dev Pulse on the price chart: each GitHub event snaps to the chart bar it happened in, and events that share a bar
// become one pin shown as its most important kind. Events are { id, kind, time (unix seconds), title, detail, url, amount }.
export const PULSE_KIND = Object.freeze({
  release: { label: 'Release', priority: 7 },
  hn: { label: 'Hacker News', priority: 6 },
  verified: { label: 'Maintainer verified', priority: 5 },
  merge: { label: 'Merged pull request', priority: 4 },
  stars: { label: 'Stars', priority: 3 },
  paid: { label: 'Builder paid', priority: 2 },
  commits: { label: 'Commits', priority: 1 },
})

// Index of the latest time <= target in an ascending array, or -1.
function latestAtOrBefore(times, target) {
  let low = 0, high = times.length - 1, found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (times[middle] <= target) { found = middle; low = middle + 1 }
    else high = middle - 1
  }
  return found
}

// barTimes: the chart's ascending bar times (whitespace bars included, so quiet periods keep their place in time).
// An event before the first bar is outside the chart; one after the last bar joins it only within one interval.
export function pulsePins(events, barTimes, { interval = 0, from = -Infinity, to = Infinity } = {}) {
  if (!events?.length || !barTimes?.length) return []
  const last = barTimes.at(-1), pins = new Map()
  for (const event of events) {
    if (!PULSE_KIND[event?.kind] || !Number.isFinite(event.time) || event.time < from || event.time > to) continue
    if (event.time >= last + Math.max(interval, 1)) continue
    const index = latestAtOrBefore(barTimes, event.time)
    if (index < 0) continue
    const time = barTimes[index]
    if (!pins.has(time)) pins.set(time, [])
    pins.get(time).push(event)
  }
  return [...pins].sort(([a], [b]) => a - b).map(([time, grouped]) => pinOf(time, grouped))
}

const leadKind = events => events.reduce((best, event) => PULSE_KIND[event.kind].priority > PULSE_KIND[best].priority ? event.kind : best, events[0].kind)
function pinOf(time, events) {
  const newest = events.toSorted((a, b) => b.time - a.time)
  return { time, kind: leadKind(newest), events: newest, count: newest.length }
}

// Pins already positioned on screen ({ ...pin, x }, ascending x) that would overlap merge into one, placed at its most
// important event; zooming in separates them again. gap: the smallest distance between pin centres, in pixels.
export function pulseClusters(placed, gap) {
  const clusters = []
  for (const pin of placed) {
    const previous = clusters.at(-1)
    if (previous && pin.x - previous.last < gap) { previous.members.push(pin); previous.last = pin.x }
    else clusters.push({ members: [pin], last: pin.x })
  }
  return clusters.map(({ members }) => {
    if (members.length === 1) return members[0]
    const merged = pinOf(0, members.flatMap(pin => pin.events))
    const anchor = members.find(pin => pin.kind === merged.kind) ?? members[0]
    return { ...merged, time: anchor.time, x: anchor.x }
  })
}

// A pin's events with its leading kind first (newest first within each part), so the card opens on what the pin shows.
export const pulseLead = pin => [...pin.events.filter(event => event.kind === pin.kind), ...pin.events.filter(event => event.kind !== pin.kind)]

const UNITS = [['day', 86400], ['hour', 3600], ['minute', 60]]
// '2h ago' for compact text; long form ('2 hours ago') for screen-reader labels.
export function pulseAge(time, now = Date.now(), { long = false } = {}) {
  const elapsed = Math.max(0, Math.floor(now / 1000 - time))
  if (elapsed < 60) return 'just now'
  const [unit, seconds] = UNITS.find(([, size]) => elapsed >= size)
  const count = Math.floor(elapsed / seconds)
  return long ? `${count} ${unit}${count === 1 ? '' : 's'} ago` : `${count}${unit[0]} ago`
}

// '20:31 UTC' for today (UTC), 'Sep 30, 14:02 UTC' for earlier days.
export function pulseUtc(time, now = Date.now()) {
  const date = new Date(time * 1000), clock = `${date.toISOString().slice(11, 16)} UTC`
  if (date.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return clock
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${clock}`
}

// One line naming the event, used for pin labels and tooltip titles.
export function pulseDescribe(event) {
  if (event.kind === 'release') return `Release ${event.title}`
  if (event.kind === 'merge') return `Merged: ${event.title}`
  if (event.kind === 'hn') return `Hacker News: ${event.title}`
  if (event.kind === 'verified') return event.title || 'Maintainer verified'
  return event.title
}

// Only https links are rendered; anything else (or a malformed URL) shows no link.
export function pulseHref(event) {
  try { const url = new URL(event?.url); return url.protocol === 'https:' ? url.href : null } catch { return null }
}

// Named after where the link goes, so the label stays right whatever the collector links to.
const LINK_HOSTS = [['news.ycombinator.com', 'View on Hacker News ↗'], ['github.com', 'View on GitHub ↗'], ['solscan.io', 'View receipt ↗']]
export function pulseLinkLabel(event) {
  const href = pulseHref(event)
  if (!href) return null
  const host = new URL(href).hostname
  return LINK_HOSTS.find(([name]) => host === name || host.endsWith(`.${name}`))?.[1] ?? 'Open link ↗'
}

export function pulsePinLabel(pin, now = Date.now()) {
  const [lead] = pulseLead(pin), more = pin.count - 1
  return `${pulseDescribe(lead)}${more ? ` and ${more} more GitHub event${more === 1 ? '' : 's'}` : ''}, ${pulseAge(lead.time, now, { long: true })}`
}
