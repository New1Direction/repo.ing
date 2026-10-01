import test from 'node:test'
import assert from 'node:assert/strict'
import { VITALS_MAX_BYTES, VITALS_SAMPLE_RATE, VITAL_ROUTES, deviceClass, parseVitalsBeacon, sampleVitals, vitalsRating, vitalsRoute, vitalsSummary } from '../app/lib/web-vitals.mjs'
import { createVitalsStore } from '../src/web-vitals-store.mjs'

test('routes are reported as patterns: no mint, repository id, query or hash ever leaves the page', () => {
  const mint = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
  assert.equal(vitalsRoute(`/token/${mint}`), '/token/[mint]')
  assert.equal(vitalsRoute(`/token/${mint}/`), '/token/[mint]')
  assert.equal(vitalsRoute(`/token/${mint}/return/250`), '/token/[mint]/return/[pct]')
  assert.equal(vitalsRoute('/claim/123456?wallet=abc#rewards'), '/claim/[repo]')
  assert.equal(vitalsRoute('/launch/987'), '/launch/[repo]')
  assert.equal(vitalsRoute('/launch'), '/launch')
  assert.equal(vitalsRoute('/'), '/')
  assert.equal(vitalsRoute(''), '/')
  assert.equal(vitalsRoute('/ja'), '/ja')
  assert.equal(vitalsRoute('/operations/vitals'), '/operations/vitals')
  assert.equal(vitalsRoute('/token'), '/other')
  assert.equal(vitalsRoute(`/token/${mint}/extra`), '/other')
  assert.equal(vitalsRoute('/wp-admin/../../etc'), '/other')
  assert.ok(VITAL_ROUTES.every(route => route.length <= 64))
})

test('about a quarter of page loads are sampled, decided once from the random source', () => {
  assert.equal(VITALS_SAMPLE_RATE, 0.25)
  assert.equal(sampleVitals(() => 0.2499), true)
  assert.equal(sampleVitals(() => 0.25), false)
  assert.equal(sampleVitals(() => 0.9, 1), true)
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const sampled = Array.from({ length: 20_000 }, () => sampleVitals(random)).filter(Boolean).length
  assert.ok(sampled > 4600 && sampled < 5400, `sampled ${sampled} of 20000`)
})

test('ratings use the web.dev thresholds; device class comes from a User-Agent heuristic only', () => {
  assert.equal(vitalsRating('LCP', 2500), 'good'); assert.equal(vitalsRating('LCP', 2500.1), 'needs-improvement'); assert.equal(vitalsRating('LCP', 4001), 'poor')
  assert.equal(vitalsRating('INP', 200), 'good'); assert.equal(vitalsRating('INP', 500), 'needs-improvement'); assert.equal(vitalsRating('INP', 501), 'poor')
  assert.equal(vitalsRating('CLS', 0.1), 'good'); assert.equal(vitalsRating('CLS', 0.25), 'needs-improvement'); assert.equal(vitalsRating('CLS', 0.3), 'poor')
  assert.equal(vitalsRating('FCP', 1800), 'good'); assert.equal(vitalsRating('TTFB', 1801), 'poor')
  assert.equal(deviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'), 'mobile')
  assert.equal(deviceClass('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131 Mobile Safari/537.36'), 'mobile')
  assert.equal(deviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131 Safari/537.36'), 'desktop')
  assert.equal(deviceClass(null), 'desktop')
})

test('beacons are validated strictly and rounded; anything else is rejected', () => {
  const beacon = metrics => JSON.stringify({ route: '/token/[mint]', metrics })
  assert.deepEqual(parseVitalsBeacon(beacon([{ name: 'LCP', value: 2345.678 }, { name: 'CLS', value: 0.123456 }, { name: 'INP', value: 88 }])), {
    route: '/token/[mint]', metrics: [{ metric: 'LCP', value: 2345.7, rating: 'good' }, { metric: 'CLS', value: 0.1235, rating: 'needs-improvement' },
      { metric: 'INP', value: 88, rating: 'good' }] })
  const rejected = [
    '', 'not json', '[]', 'null', JSON.stringify({ route: '/token/abc', metrics: [{ name: 'LCP', value: 1 }] }),
    JSON.stringify({ route: '/other', metrics: [] }),
    JSON.stringify({ route: '/', metrics: [{ name: 'LCP', value: 1 }], url: 'https://repo.ing/?wallet=x' }),
    beacon([{ name: 'LCP', value: 1, id: 'v3-123' }]),
    beacon([{ name: 'FID', value: 1 }]),
    beacon([{ name: 'LCP', value: '1' }]),
    beacon([{ name: 'LCP', value: -1 }]),
    beacon([{ name: 'LCP', value: 600_001 }]),
    beacon([{ name: 'CLS', value: 101 }]),
    beacon([{ name: 'LCP', value: 1 }, { name: 'LCP', value: 2 }]),
    beacon(Array.from({ length: 6 }, (_, i) => ({ name: ['LCP', 'INP', 'CLS', 'FCP', 'TTFB', 'LCP'][i], value: 1 }))),
    beacon([null]),
    'x'.repeat(VITALS_MAX_BYTES + 1),
  ]
  for (const text of rejected) assert.throws(() => parseVitalsBeacon(text), /INVALID_VITALS/, text.slice(0, 60))
})

test('summary rows become per-route p75 cells with ratings and sample counts, busiest routes first', () => {
  const rows = [
    { route: '/explore', metric: 'LCP', samplesDay: 0, p75Day: null, samplesWeek: 3, p75Week: 2600 },
    { route: '/token/[mint]', metric: 'LCP', samplesDay: 12, p75Day: 2100.5, samplesWeek: 40, p75Week: 4200 },
    { route: '/token/[mint]', metric: 'CLS', samplesDay: 12, p75Day: 0.02, samplesWeek: 40, p75Week: 0.3 },
  ]
  assert.deepEqual(vitalsSummary(rows), [
    { route: '/token/[mint]', metrics: {
      LCP: { day: { p75: 2100.5, samples: 12, rating: 'good' }, week: { p75: 4200, samples: 40, rating: 'poor' } },
      CLS: { day: { p75: 0.02, samples: 12, rating: 'good' }, week: { p75: 0.3, samples: 40, rating: 'poor' } } } },
    { route: '/explore', metrics: { LCP: { day: { p75: null, samples: 0, rating: null }, week: { p75: 2600, samples: 3, rating: 'needs-improvement' } } } },
  ])
  assert.deepEqual(vitalsSummary([]), [])
})

test('the store writes one beacon in one statement and prunes at most once per interval', async () => {
  let now = 0
  const queries = []
  const pool = { query: async (sql, params) => { queries.push([sql.replace(/\s+/g, ' ').trim().slice(0, 41), params]); return { rows: [], rowCount: 0 } } }
  const store = createVitalsStore(pool, { now: () => now, pruneEveryMs: 1000 })
  const metrics = [{ metric: 'LCP', value: 1200, rating: 'good' }, { metric: 'TTFB', value: 300, rating: 'good' }]
  await store.record({ route: '/explore', device: 'mobile', metrics })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(queries.map(([sql]) => sql), ['insert into web_vitals(route, metric, val', 'delete from web_vitals where created_at <'])
  assert.deepEqual(queries[0][1], ['/explore', 'mobile', ['LCP', 'TTFB'], [1200, 300], ['good', 'good']])
  assert.deepEqual(queries[1][1], [14])
  now = 999; await store.record({ route: '/explore', device: 'mobile', metrics })
  assert.equal(queries.length, 3, 'no second prune inside the interval')
  now = 1000; await store.record({ route: '/', device: 'desktop', metrics })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(queries.filter(([sql]) => sql.startsWith('delete')).length, 2)
})
