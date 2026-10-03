import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { MOVING_NOW_LIMIT, moverFacts, movingNow, proofFacts } from '../app/lib/home-highlights.mjs'
import { homeMarketTabs } from '../app/lib/market-order.mjs'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const market = (id, volume, { hoursOld = id, promoted = true, ...rest } = {}) => ({ repoId: String(id), mint: `Mint${id}`, fullName: `owner/repo-${id}`, symbol: `R${id}`,
  volume24hLamports: String(volume), indexedAt: new Date(NOW - hoursOld * 3_600_000).toISOString(), promoted, priceSol: null, bondingPercent: 12.5, graduated: false, ...rest })

test('moving now: promoted markets that traded in the last 24 hours, busiest first, at most four', () => {
  const markets = [market(1, 0), market(2, 5e9), market(3, 9e9), market(4, 1e9, { promoted: false }), market(5, 2e9), market(6, 3e9), market(7, 4e9)]
  const picked = movingNow(markets)
  assert.equal(picked.kind, 'moving')
  assert.deepEqual(picked.markets.map(m => m.repoId), ['3', '2', '7', '6'])
  assert.equal(picked.markets.length, MOVING_NOW_LIMIT)
  assert.deepEqual(movingNow([market(1, 0), market(2, 7e8)]).markets.map(m => m.repoId), ['2'], 'one mover is shown alone, never padded with idle markets')
})

test('moving now: on a day nothing traded, the newest promoted launches instead; nothing at all without markets', () => {
  const picked = movingNow([market(1, 0, { hoursOld: 30 }), market(2, 0, { hoursOld: 2 }), market(3, 0, { hoursOld: 1, promoted: false })])
  assert.deepEqual(picked, { kind: 'new', markets: [picked.markets[0], picked.markets[1]] })
  assert.deepEqual(picked.markets.map(m => m.repoId), ['2', '1'])
  assert.deepEqual(movingNow([]), { kind: 'new', markets: [] })
})

test('a card shows 24h volume, how long ago it launched, market cap and where it stands', () => {
  assert.deepEqual(moverFacts(market(1, 2_345_000_000, { hoursOld: 3, priceSol: 0.00005 }), 150, NOW),
    { volume: '2.35 SOL', launched: '3 hours ago', cap: moverFacts(market(1, 0, { priceSol: 0.00005 }), 150, NOW).cap, stage: '12% to graduation' })
  assert.match(moverFacts(market(1, 0, { priceSol: 0.00005 }), 150, NOW).cap, /^\$/)
  assert.equal(moverFacts(market(1, 0, { graduated: true }), null, NOW).stage, 'Graduated')
  assert.equal(moverFacts(market(1, 0), null, NOW).cap, null, 'no trade yet: no market cap')
})

test('proof line: all-time volume floored to whole SOL, builder payouts and buybacks, each only while known', () => {
  const receipts = [{ signature: 'a', source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint, spentLamports: '51560000000', tokenBaseUnits: '140180000000000', at: '2026-10-03T10:00:00Z' }]
  assert.deepEqual(proofFacts({ totals: { volume: '6962999999999', paid: '33460000000' }, receipts }), [
    { id: 'traded', value: '6,962 SOL', label: 'traded' },
    { id: 'paid', value: '33.46 SOL', label: 'paid to builders' },
    { id: 'bought', value: '51.56 SOL', label: 'bought back', href: '/stats#repo-title' },
  ])
  assert.deepEqual(proofFacts({ totals: { volume: '0', paid: '0' }, receipts: [] }), [])
  assert.deepEqual(proofFacts(), [])
})

test('trending lists only markets that traded in the last 24 hours; New still lists every market', () => {
  const tabs = homeMarketTabs([market(1, 0), market(2, 4e9), market(3, 0), market(4, 1e9)])
  assert.deepEqual(tabs.Trending.map(m => m.repoId), ['2', '4'])
  assert.deepEqual(tabs.New.map(m => m.repoId), ['1', '2', '3', '4'])
})

const { MovingNowStrip, HomeProofLine, MovingNowFallback } = await appModule('app/components/home-highlights.jsx')

test('the strip: each card links to its market, says what moved, and the heading says whether it is live or new', () => {
  const live = html(h(MovingNowStrip, { kind: 'moving', markets: [market(1, 2_500_000_000)], now: NOW }))
  assert.match(live, /<h2 id="moving-now-title"><span class="moving-now-dot" aria-hidden="true"><\/span>Moving now<\/h2>/)
  assert.match(live, /<a class="mover-card" aria-label="owner\/repo-1, \$R1: 24h volume 2\.5 SOL" href="\/token\/Mint1"><div class="mover-top"><div class="repo-avatar normal">/)
  assert.match(live, /<small>24h volume<\/small><strong>2\.5 SOL<\/strong>/)
  assert.ok(!live.includes('model-disclaimer'), 'no disclaimer without a model market')
  const fresh = html(h(MovingNowStrip, { kind: 'new', markets: [market(2, 0, { hoursOld: 2 })], now: NOW }))
  assert.match(fresh, />Just launched<\/h2>/)
  assert.match(fresh, /<small>Launched<\/small><strong>2 hours ago<\/strong>/)
  assert.ok(!fresh.includes('0 SOL'), 'a fresh launch never shows a zero volume')
})

test('the proof line links the buyback figure to its receipts; the placeholder reserves the line', () => {
  const markup = html(h(HomeProofLine, { facts: [{ id: 'traded', value: '6,962 SOL', label: 'traded' }, { id: 'bought', value: '51.56 SOL', label: 'bought back', href: '/stats#repo-title' }] }))
  assert.equal(markup, '<p class="home-proof"><span><strong>6,962 SOL</strong> traded</span><span><a href="/stats#repo-title"><strong>51.56 SOL</strong> bought back</a></span></p>')
  assert.match(html(h(MovingNowFallback)), /aria-busy="true"/)
})
