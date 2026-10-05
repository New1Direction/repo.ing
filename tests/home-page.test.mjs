import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { LIVE_TRADE_ROWS, lastPoint, liveChart } from '../app/lib/live-market.mjs'

// The home page: the live $REPOING card, the tabbed market board and the Shipping tab (app/(site)/page.jsx).
const { LiveMarket, LiveMarketFallback } = await appModule('app/components/home/live-market.jsx')
const { HomeBoard, tabForKey } = await appModule('app/components/home/home-board.jsx')
const { ShippingLeaders } = await appModule('app/components/shipping-leaders.jsx')

const NOW = Date.parse('2026-10-03T12:00:00Z'), NOW_S = NOW / 1000
const sig = n => `${'5'.repeat(86)}${'ABCDEFGHJK'[n]}`
// Thirty hourly bars ending an hour ago, rising 1% an hour from 1e-6 SOL; five swaps a minute apart, oldest first.
const payload = (latest = 1.3e-6) => ({
  range: '7d', interval: 3600, volume24hLamports: '255564891086', latest: { priceSol: latest, signature: sig(9) }, totalTrades: 11717,
  candles: Array.from({ length: 30 }, (_, i) => ({ time: NOW_S - (30 - i) * 3600, open: 1e-6 * (1 + i / 100), high: 2e-6, low: 5e-7,
    close: 1e-6 * (1 + i / 100), volumeLamports: '1000', count: 2 })),
  trades: Array.from({ length: 5 }, (_, k) => ({ signature: sig(k), eventIndex: k, direction: k % 2 ? 'sell' : 'buy', venue: 'DAMM',
    tradedAt: new Date(NOW - (5 - k) * 60_000).toISOString(), priceSol: 1e-6, solLamports: String((k + 1) * 100_000_000), tokenBaseUnits: '1' })),
})
const market = { mint: 'MintRepoing', repoId: '1388219884', symbol: 'REPOING', fullName: 'New1Direction/repo.ing', source: 'github',
  priceSol: 1.3e-6, volume24hLamports: '255564891086', earned: '31880000000' }

test('the live card keeps only what it draws: bars, the newest swaps newest first, the latest price and 24h volume', () => {
  const chart = liveChart(payload())
  assert.deepEqual(Object.keys(chart).sort(), ['candles', 'interval', 'latest', 'trades', 'volume24hLamports'])
  assert.deepEqual(chart.candles[0], { time: NOW_S - 30 * 3600, open: 1e-6, close: 1e-6 })
  assert.deepEqual(chart.latest, { priceSol: 1.3e-6 })
  assert.equal(chart.trades.length, LIVE_TRADE_ROWS)
  assert.deepEqual(chart.trades.map(trade => trade.eventIndex), [4, 3, 2, 1])
  assert.deepEqual(Object.keys(chart.trades[0]).sort(), ['direction', 'eventIndex', 'signature', 'solLamports', 'tradedAt'])
  // A swap confirmed but not finalized yet keeps its mark, so the card can say so.
  const confirming = payload()
  confirming.trades = confirming.trades.map((trade, i, all) => i === all.length - 1 ? { ...trade, pending: true } : trade)
  assert.equal(liveChart(confirming).trades[0].pending, true)
  assert.equal(liveChart(confirming).trades[1].pending, undefined)
  assert.equal(liveChart({ ...payload(), volume24hLamports: '1.5' }).volume24hLamports, null)
  assert.equal(liveChart({ ...payload(), latest: { priceSol: 0 } }).latest, null)
  for (const bad of [null, {}, { candles: [] }, { candles: 'x', interval: 60 }]) assert.equal(liveChart(bad), null, JSON.stringify(bad))
})

test('the live dot sits on the sparkline\'s last point', () => {
  assert.deepEqual(lastPoint('M4.0 100.0 L160.0 56.0 L316.0 8.0', 320, 112), { left: 98.75, top: 8 / 112 * 100 })
  assert.equal(lastPoint('', 320, 112), null)
})

test('the live card: price and its 24h change, the chart, market cap, volume, builders\' earnings, the newest swaps and the way to trade', () => {
  const markup = html(h(LiveMarket, { market, initial: liveChart(payload()), usdPerSol: 150, renderedAt: NOW }))
  assert.match(markup, /<h2 id="live-market-title">\$REPOING<\/h2><span>New1Direction\/repo\.ing<\/span>/)
  assert.match(markup, /<strong>\$0\.000195<\/strong>/)
  // The close a day ago was 1.05e-6 SOL; the latest is 1.3e-6.
  assert.match(markup, /<span class="live-change is-up"><span aria-hidden="true">▲<\/span> 23\.81%<\/span>/)
  assert.match(markup, /<div class="live-chart is-up"><svg viewBox="0 0 320 112" preserveAspectRatio="none" role="img" aria-label="\$REPOING price over the last 24 hours, up 23\.81%">/)
  assert.match(markup, /<span class="live-chart-dot" style="left:98\.75%;top:/)
  assert.match(markup, /<dt>Builders earned<\/dt><dd>31\.88 SOL<\/dd>/)
  assert.equal(markup.match(/<li class="live-trade">/g).length, LIVE_TRADE_ROWS)
  assert.match(markup, /<span class="live-trade-side buy">Buy<\/span><strong>0\.5 SOL<\/strong>/)
  assert.match(markup, /<span class="live-trade-side sell">Sell<\/span><strong>0\.4 SOL<\/strong>/)
  assert.match(markup, /<a class="button primary live-market-cta" href="\/token\/MintRepoing">Trade \$REPOING/)
})

test('a falling market reads down, in the chart\'s label too; without a SOL price the figures stay in SOL', () => {
  const markup = html(h(LiveMarket, { market, initial: liveChart(payload(9e-7)), usdPerSol: null, renderedAt: NOW }))
  assert.match(markup, /<span class="live-change is-down"><span aria-hidden="true">▼<\/span> −14\.29%<\/span>/)
  assert.match(markup, /aria-label="\$REPOING price over the last 24 hours, down 14\.29%"/)
  assert.match(markup, /<strong>9\.000e-7 SOL<\/strong>/)
})

test('the card\'s placeholder has the card\'s blocks (so nothing moves when it streams in); an unreadable market keeps the way to trade', () => {
  const loading = html(h(LiveMarketFallback))
  assert.match(loading, /<article class="live-market is-loading" aria-busy="true">/)
  assert.deepEqual([...loading.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]), ['Market cap', '24h volume', 'Builders earned'])
  assert.equal(loading.match(/<li class="live-trade">/g).length, LIVE_TRADE_ROWS)
  assert.match(loading, /<span class="button primary live-market-cta is-placeholder" aria-hidden="true">Trade<\/span><\/article>$/)
  const unavailable = html(h(LiveMarketFallback, { unavailable: true }))
  assert.doesNotMatch(unavailable, /aria-busy/)
  assert.match(unavailable, /role="status">Live prices are temporarily unavailable\.</)
  assert.match(unavailable, /<a class="button primary live-market-cta" href="\/token\/59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be">Trade \$REPOING/)
})

test('board keys: arrows wrap, Home and End jump, and a key held with a modifier is left to the browser', () => {
  assert.equal(tabForKey({ key: 'ArrowRight' }, 0, 4), 1)
  assert.equal(tabForKey({ key: 'ArrowRight' }, 3, 4), 0)
  assert.equal(tabForKey({ key: 'ArrowLeft' }, 0, 4), 3)
  assert.equal(tabForKey({ key: 'Home' }, 2, 4), 0)
  assert.equal(tabForKey({ key: 'End' }, 0, 4), 3)
  assert.equal(tabForKey({ key: 'Enter' }, 0, 4), null)
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) assert.equal(tabForKey({ key: 'ArrowLeft', [modifier]: true }, 1, 4), null, modifier)
})

test('the board: one tab list, the first tab open, every other list rendered but hidden, and the board\'s own links', () => {
  const tabs = [{ id: 'trending', label: 'Trending', note: 'Ranked by 24h volume.' }, { id: 'new', label: 'New' }]
  const markup = html(h(HomeBoard, { title: 'Markets', tabs, panels: { trending: h('p', null, 'busiest'), new: h('p', null, 'newest') },
    action: h('a', { href: '/explore' }, 'View all'), footer: h('a', { href: '/waiting' }, 'Waiting') }))
  assert.match(markup, /<h2 id="home-board-title">Markets<\/h2><div class="home-board-tabs" role="tablist" aria-label="Markets">/)
  assert.match(markup, /^<section class="home-board" aria-labelledby="home-board-title"><span id="trending" class="home-board-anchor" aria-hidden="true"><\/span><span id="new" class="home-board-anchor" aria-hidden="true"><\/span>/, 'one anchor per tab, so /#new lands on the board')
  assert.match(markup, /<button type="button" role="tab" id="home-tab-trending" aria-controls="home-panel-trending" aria-selected="true" tabindex="0">Trending<\/button>/)
  assert.match(markup, /<button type="button" role="tab" id="home-tab-new" aria-controls="home-panel-new" aria-selected="false" tabindex="-1">New<\/button>/)
  assert.match(markup, /<div class="home-board-panel" role="tabpanel" id="home-panel-trending" aria-labelledby="home-tab-trending"><p class="home-board-note">Ranked by 24h volume\.<\/p><p>busiest<\/p><\/div>/)
  assert.match(markup, /id="home-panel-new" aria-labelledby="home-tab-new" hidden=""><p>newest<\/p><\/div>/)
  assert.match(markup, /<a href="\/explore">View all<\/a><\/div>/)
  assert.match(markup, /<a href="\/waiting">Waiting<\/a><\/section>$/)
})

test('the Shipping tab lists who shipped most this week, and says so when nobody has', () => {
  const leaders = [{ mint: 'MintA', repoId: '1', fullName: 'owner/a', symbol: 'A', pulse: { commits7d: 2048, merged7d: 295, devs7d: 263 } }]
  const markup = html(h(ShippingLeaders, { markets: leaders }))
  assert.match(markup, /<ol class="shipping-leaders-list"><li><a class="shipping-card" href="\/token\/MintA">/)
  assert.match(markup, /<b>2,048<\/b> commits/)
  assert.match(markup, /<a class="home-board-more" href="\/explore\?view=shipping">Every repository by code shipped/)
  assert.equal(html(h(ShippingLeaders, { markets: [] })), '<p class="home-board-empty">No repository has shipped code this week yet.</p>')
})
