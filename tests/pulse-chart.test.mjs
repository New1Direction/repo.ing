import test from 'node:test'
import assert from 'node:assert/strict'
import { PULSE_KIND, pulseAge, pulseClusters, pulseDescribe, pulseHref, pulseLead, pulseLinkLabel, pulsePinLabel, pulsePins, pulseUtc } from '../app/lib/pulse-chart.mjs'

const HOUR = 3600
const bars = [0, 1, 2, 3, 4].map(i => 1_790_000_000 + i * HOUR)
const event = (kind, time, extra = {}) => ({ id: `${kind}:${time}`, kind, time, title: `${kind} title`, detail: null, url: null, amount: null, ...extra })

test('events snap to the bar they happened in, including quiet whitespace bars', () => {
  // Arrange: one event mid-way through the second bar, one exactly on the fourth
  const events = [event('release', bars[1] + 1800), event('merge', bars[3])]

  // Act
  const pins = pulsePins(events, bars, { interval: HOUR })

  // Assert
  assert.deepEqual(pins.map(pin => pin.time), [bars[1], bars[3]])
  assert.deepEqual(pins.map(pin => pin.kind), ['release', 'merge'])
})

test('events sharing a bar become one pin led by the most important kind, newest first', () => {
  const events = [event('commits', bars[2] + 60, { amount: 4 }), event('release', bars[2] + 120), event('stars', bars[2] + 3000)]

  const [pin, ...rest] = pulsePins(events, bars, { interval: HOUR })

  assert.equal(rest.length, 0)
  assert.equal(pin.kind, 'release')
  assert.equal(pin.count, 3)
  assert.deepEqual(pin.events.map(item => item.kind), ['stars', 'release', 'commits'])
})

test('kind priority follows release > hn > verified > merge > stars > paid > commits', () => {
  const order = Object.entries(PULSE_KIND).sort(([, a], [, b]) => b.priority - a.priority).map(([kind]) => kind)

  assert.deepEqual(order, ['release', 'hn', 'verified', 'merge', 'stars', 'paid', 'commits'])
})

test('events before the first bar are dropped', () => {
  const pins = pulsePins([event('release', bars[0] - 1)], bars, { interval: HOUR })

  assert.deepEqual(pins, [])
})

test('an event after the last bar joins it only within one interval', () => {
  const inside = event('release', bars.at(-1) + HOUR - 1)
  const outside = event('merge', bars.at(-1) + HOUR)

  const pins = pulsePins([inside, outside], bars, { interval: HOUR })

  assert.equal(pins.length, 1)
  assert.equal(pins[0].time, bars.at(-1))
  assert.equal(pins[0].kind, 'release')
})

test('unknown kinds, invalid times and events outside from/to are ignored', () => {
  const events = [event('deploy', bars[1]), event('release', Number.NaN), event('merge', bars[1]), event('hn', bars[3])]

  const pins = pulsePins(events, bars, { interval: HOUR, from: bars[0], to: bars[2] })

  assert.deepEqual(pins.map(pin => [pin.time, pin.kind]), [[bars[1], 'merge']])
})

test('no events or no bars give no pins', () => {
  assert.deepEqual(pulsePins([], bars), [])
  assert.deepEqual(pulsePins(null, bars), [])
  assert.deepEqual(pulsePins([event('release', bars[1])], []), [])
})

test('ages read compact in text and in full for screen readers', () => {
  const now = (bars[0] + 2 * HOUR + 5) * 1000

  assert.equal(pulseAge(bars[0], now), '2h ago')
  assert.equal(pulseAge(bars[0], now, { long: true }), '2 hours ago')
  assert.equal(pulseAge(bars[0] + 2 * HOUR - 60, now, { long: true }), '1 minute ago')
  assert.equal(pulseAge(bars[0] + 2 * HOUR, now), 'just now')
  assert.equal(pulseAge(bars[0] - 3 * 86400, now), '3d ago')
})

test('UTC times show the clock for today and the date for earlier days', () => {
  const sameDay = (1_790_000_000 + 3 * HOUR) * 1000, nextDay = (1_790_000_000 + 12 * HOUR) * 1000

  assert.equal(pulseUtc(1_790_000_000, sameDay), '14:13 UTC')
  assert.equal(pulseUtc(1_790_000_000, nextDay), 'Sep 21, 14:13 UTC')
})

test('pin labels name the event and its age', () => {
  const now = (bars[1] + 2 * HOUR) * 1000
  const single = pulsePins([event('release', bars[1], { title: 'v0.3' })], bars, { interval: HOUR })[0]
  const grouped = pulsePins([event('release', bars[1], { title: 'v0.3' }), event('merge', bars[1] + 60, { title: 'Add router' })], bars, { interval: HOUR })[0]

  assert.equal(pulsePinLabel(single, now), 'Release v0.3, 2 hours ago')
  assert.equal(pulsePinLabel(grouped, now), 'Release v0.3 and 1 more GitHub event, 2 hours ago')
  assert.equal(pulseDescribe(event('hn', 0, { title: 'Show HN: ry' })), 'Hacker News: Show HN: ry')
  assert.equal(pulseDescribe(event('verified', 0, { title: '' })), 'Maintainer verified')
})

test('a pin card opens on its leading kind, then the rest newest first', () => {
  const pin = pulsePins([event('commits', bars[2] + 900), event('release', bars[2] + 60), event('merge', bars[2] + 1200)], bars, { interval: HOUR })[0]

  const ordered = pulseLead(pin)

  assert.deepEqual(ordered.map(item => item.kind), ['release', 'merge', 'commits'])
})

test('pins closer than the gap merge into one at their most important event', () => {
  // Arrange: three pins 10px apart, then one far away
  const placed = pulsePins([event('commits', bars[0]), event('release', bars[1]), event('stars', bars[2]), event('merge', bars[4])], bars, { interval: HOUR })
    .map((pin, index) => ({ ...pin, x: [100, 110, 120, 300][index] }))

  // Act
  const clusters = pulseClusters(placed, 26)

  // Assert
  assert.equal(clusters.length, 2)
  assert.deepEqual([clusters[0].kind, clusters[0].count, clusters[0].x, clusters[0].time], ['release', 3, 110, bars[1]])
  assert.deepEqual(clusters[0].events.map(item => item.kind), ['stars', 'release', 'commits'])
  assert.equal(clusters[1], placed[3])
})

test('a long run of close pins does not chain into one: each group is less than the gap wide', () => {
  // Arrange: a star spike every hour for 40 hours, 20px apart on the chart (a viral repository on a 1.5-day chart)
  const hours = Array.from({ length: 40 }, (_, index) => bars[0] + index * HOUR)
  const placed = pulsePins(hours.map(time => event('stars', time)), hours, { interval: HOUR })
    .map((pin, index) => ({ ...pin, x: index * 20 }))

  // Act
  const clusters = pulseClusters(placed, 26)

  // Assert: 20 pins of two spikes each, spread along the whole run, never one pin at its start
  assert.equal(clusters.length, 20)
  assert.deepEqual(clusters.map(pin => pin.x), Array.from({ length: 20 }, (_, index) => index * 40))
  assert.ok(clusters.every(pin => pin.count === 2))
  for (let index = 1; index < clusters.length; index++) assert.ok(clusters[index].x - clusters[index - 1].x >= 26)
})

test('pins at least the gap apart stay separate', () => {
  const placed = pulsePins([event('release', bars[0]), event('merge', bars[1])], bars, { interval: HOUR })
    .map((pin, index) => ({ ...pin, x: [100, 126][index] }))

  assert.deepEqual(pulseClusters(placed, 26), placed)
  assert.deepEqual(pulseClusters([], 26), [])
})

test('links render only for https URLs and are named after their destination', () => {
  assert.equal(pulseLinkLabel(event('release', 0, { url: 'https://github.com/ygwyg/ry/releases/tag/v0.3' })), 'View on GitHub ↗')
  assert.equal(pulseLinkLabel(event('hn', 0, { url: 'https://news.ycombinator.com/item?id=1' })), 'View on Hacker News ↗')
  assert.equal(pulseLinkLabel(event('paid', 0, { url: 'https://solscan.io/tx/abc' })), 'View receipt ↗')
  assert.equal(pulseLinkLabel(event('verified', 0, { url: 'https://repo.ing/claim/1' })), 'Open link ↗')
  assert.equal(pulseHref(event('release', 0, { url: 'javascript:alert(1)' })), null)
  assert.equal(pulseHref(event('release', 0, { url: 'http://github.com/x' })), null)
  assert.equal(pulseLinkLabel(event('release', 0, { url: null })), null)
})
