import test from 'node:test'
import assert from 'node:assert/strict'
import { createSlowLog, serverTimingHeader, timed, timingName, withServerTiming } from '../app/lib/server-timing.mjs'
import { MARKET_ACTIVITY_CACHE, MARKET_CURVE_CACHE, MARKET_METRICS_CACHE, MARKET_TRADES_CACHE, GROWTH_CACHE, NO_STORE, REPO_SEARCH_CACHE,
  marketCacheHeaders, publicCacheHeaders } from '../app/lib/cache-headers.mjs'
import { createChartCache } from '../app/lib/chart-cache.mjs'
import { marketCurveUrl, marketTradesUrl } from '../app/lib/market-chart-urls.mjs'
import { trendOperatorView } from '../src/trend-intake.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))

test('slow loaders log one compact line per label and window, folding the rest into the next line', () => {
  let now = 0
  const lines = []
  const log = createSlowLog({ thresholdMs: 150, windowMs: 60_000, now: () => now, write: line => lines.push(JSON.parse(line)) })
  assert.equal(log('listMarkets', 150), false, 'at the threshold is not slow')
  assert.equal(log('listMarkets', 151.4), true)
  assert.deepEqual(lines, [{ slowLoader: { label: 'listMarkets', ms: 151 } }])
  now = 10_000
  assert.equal(log('listMarkets', 400), false)
  assert.equal(log('listMarkets', 900), false)
  assert.equal(log('chart', 200), true, 'labels have separate windows')
  now = 60_001
  assert.equal(log('listMarkets', 160), true)
  assert.deepEqual(lines.at(-1), { slowLoader: { label: 'listMarkets', ms: 160, foldedSlow: 2, foldedMaxMs: 900 } })
  assert.equal(lines.length, 3)
})

test('timed returns the loader result, times failures too, and feeds the Server-Timing of its request', async () => {
  const seen = []
  let clock = 0
  const tick = () => clock
  const result = await timed('market', async () => { clock += 12.34; return 'row' }, { log: (label, ms) => seen.push([label, ms]), clock: tick })
  assert.equal(result, 'row')
  await assert.rejects(timed('chart', async () => { clock += 5; throw Error('down') }, { log: (label, ms) => seen.push([label, ms]), clock: tick }), /down/)
  assert.deepEqual(seen, [['market', 12.34], ['chart', 5]])

  const handler = withServerTiming(async () => {
    await timed('market', async () => 'm', { log: () => {} })
    await Promise.all([timed('chart', async () => 'c', { log: () => {} }), timed('bad label;dur=9', async () => 'x', { log: () => {} })])
    return Response.json({ ok: true })
  })
  const response = await handler(new Request('http://localhost/api/x'))
  const header = response.headers.get('Server-Timing')
  assert.match(header, /^market;dur=\d+\.\d, chart;dur=\d+\.\d, bad_label_dur_9;dur=\d+\.\d, total;dur=\d+\.\d$/)
  // Outside a wrapped route (pages), timing only feeds the slow log.
  assert.equal(await timed('market', async () => 1, { log: () => {} }), 1)
  assert.equal(timingName(''), 'loader')
  assert.equal(serverTimingHeader([{ name: 'a', ms: -1 }], 3.14159), 'a;dur=0.0, total;dur=3.1')
})

test('public API cache headers: browsers always refetch, the CDN keeps a short copy, live refetches skip it', () => {
  assert.deepEqual(publicCacheHeaders(2), { 'Cache-Control': 'public, max-age=0, s-maxage=2', 'CDN-Cache-Control': 'max-age=2' })
  assert.deepEqual(publicCacheHeaders(15, 45), { 'Cache-Control': 'public, max-age=0, s-maxage=15', 'CDN-Cache-Control': 'max-age=15, stale-while-revalidate=45' })
  for (const bad of [[0], [1.5], [2, -1], [2, 0.5], ['2']]) assert.throws(() => publicCacheHeaders(...bad), /Invalid cache lifetime/)
  for (const headers of [MARKET_TRADES_CACHE, MARKET_CURVE_CACHE, MARKET_ACTIVITY_CACHE, MARKET_METRICS_CACHE, REPO_SEARCH_CACHE, GROWTH_CACHE]) {
    // Browser-facing: no reuse without a refetch, and never stale-while-revalidate (a chart must not paint an old copy).
    assert.match(headers['Cache-Control'], /^public, max-age=0, s-maxage=\d+$/)
    assert.doesNotMatch(headers['Cache-Control'], /stale-while-revalidate|private|no-store/)
  }
  // Live data an SSE hint refetches has no stale window at the edge either.
  assert.equal(MARKET_TRADES_CACHE['CDN-Cache-Control'], 'max-age=2')
  assert.equal(MARKET_CURVE_CACHE['CDN-Cache-Control'], 'max-age=2')
  const mint = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
  assert.equal(marketCacheHeaders(new Request(`http://localhost${marketTradesUrl(mint, 'all', { fresh: true })}`), MARKET_TRADES_CACHE), NO_STORE)
  assert.equal(marketCacheHeaders(new Request(`http://localhost${marketTradesUrl(mint)}`), MARKET_TRADES_CACHE), MARKET_TRADES_CACHE)
  assert.equal(marketTradesUrl(mint), `/api/market/${mint}/trades?range=all`)
  assert.equal(marketTradesUrl(mint, '24h', { fresh: true }), `/api/market/${mint}/trades?range=24h&fresh=1`)
  assert.equal(marketCurveUrl(mint, { fresh: true }), `/api/market/${mint}/curve?fresh=1`)
  assert.equal(marketCurveUrl(mint), `/api/market/${mint}/curve`)
})

test('chart cache: one build per mint and range, expiry, trade hints drop entries, unknown markets are never kept', async () => {
  let now = 0, loads = 0, release
  const listeners = new Map(), unsubscribed = []
  const subscribe = (mint, onChange) => { listeners.set(mint, onChange); return () => { unsubscribed.push(mint); listeners.delete(mint) } }
  const cache = createChartCache({ ttlMs: 3000, now: () => now, subscribe, maxMints: 2,
    load: (mint, range) => { loads++; return mint === 'unknown' ? null : new Promise(resolve => { release = () => resolve(`${mint}:${range}:${loads}`) }) } })
  const pending = [cache.get('A', 'all'), cache.get('A', 'all')]
  await flush(); release()
  assert.deepEqual(await Promise.all(pending), ['A:all:1', 'A:all:1'])
  assert.equal(loads, 1)
  assert.ok(listeners.has('A'), 'a known market subscribes to trade hints after its first build')
  now = 2999; assert.equal(await cache.get('A', 'all'), 'A:all:1'); assert.equal(loads, 1)
  now = 3000; const expired = cache.get('A', 'all'); await flush(); release(); assert.equal(await expired, 'A:all:2')

  // A trade hint drops the entries; a build that was running when it arrived is served to its waiters but not kept.
  const racing = cache.get('A', '24h'); await flush()
  listeners.get('A')()
  release(); assert.equal(await racing, 'A:24h:3')
  const afterHint = cache.get('A', '24h'); await flush(); release(); assert.equal(await afterHint, 'A:24h:4')
  listeners.get('A')()
  const rebuilt = cache.get('A', 'all'); await flush(); release(); assert.equal(await rebuilt, 'A:all:5')

  assert.equal(await cache.get('unknown', 'all'), null)
  assert.equal(listeners.has('unknown'), false)
  assert.equal(cache.size(), 1, 'an unknown mint leaves nothing behind')

  // Bounded: a third mint evicts the least recently used one and ends its subscription.
  const b = cache.get('B', 'all'); await flush(); release(); await b
  const c = cache.get('C', 'all'); await flush(); release(); await c
  assert.deepEqual(unsubscribed, ['A'])
  assert.equal(cache.size(), 2)

  const failing = createChartCache({ load: async () => { throw Error('db down') } })
  await assert.rejects(failing.get('A', 'all'), /db down/)
  await assert.rejects(failing.get('A', 'all'), /db down/, 'failures are retried, not cached')
})

test('trend view reads every candidate in a fixed number of queries (no per-candidate round trips)', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => String(1000 + i))
  const at = new Date('2026-10-01T10:00:00Z')
  const queries = []
  const pool = { async query(sql, params) {
    queries.push(sql)
    if (sql.includes('from trend_candidates order by detected_at')) return { rows: ids.map(id => ({ id })) }
    if (sql.includes('from trend_source_health')) return { rows: [{ source: 'intake', status: 'OK', checkedAt: at, detail: '{"source":"intake"}' }] }
    if (sql.includes('from trend_observations')) return { rows: params[0].flatMap(id => [0, 1, 2].map(k => ({ repoId: id, evidence: JSON.stringify({ observedAt: new Date(at - k * 3_600_000).toISOString(), stars: 100 - k * Number(id.at(-1)), forks: 1 }) }))) }
    if (sql.includes('from trend_signals')) return { rows: params[0].slice(0, 2).map(id => ({ repoId: id, signalId: 1, source: 'hn', url: `https://news.ycombinator.com/item?id=${id}`, note: 'story', occurredAt: at, expiresAt: new Date(+at + 86_400_000), detectedAt: at, operator: null })) }
    return { rows: params[0].map(id => ({ repoId: id, fullName: `o/r${id}`, description: null, state: 'detected', revision: 0, observedAt: at, error: null, marketStatus: null })) }
  } }
  const view = await trendOperatorView(pool, +at + 60_000)
  assert.equal(queries.length, 5)
  assert.equal(view.candidates.length, 60)
  assert.deepEqual(view.sources, [{ source: 'intake', status: 'OK', checkedAt: at, detail: { source: 'intake' } }])
  const top = view.candidates[0]
  assert.equal('signalId' in (top.signals[0] ?? {}), false, 'internal ordering keys never leave the view')
  assert.ok(view.candidates.every((c, i, list) => i === 0 || list[i - 1].score.total >= c.score.total))
  assert.equal(view.candidates.find(c => c.repoId === '1000').signals.length, 1)
  assert.equal(view.candidates.find(c => c.repoId === '1059').latestObservation.stars, 100)
})
