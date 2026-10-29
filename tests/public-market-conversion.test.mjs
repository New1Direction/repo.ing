import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { launchWindow } from '../app/lib/public-launch.mjs'
import { parseMarketEvent, sendMarketEvent } from '../app/lib/market-funnel.mjs'

const { MarketDecision } = await appModule('app/components/market-decision.jsx')
const { LiquidityCard } = await appModule('app/components/market-transparency.jsx')
const { ScheduledLaunchBlocked, ScheduledWindowNote } = await appModule('app/components/scheduled-launch.jsx')
const { POST } = await appModule('app/api/market-events/route.js')
const start = Date.parse('2026-10-15T12:00:00Z'), end = start + 3600_000
const schedule = { id: '1', repoId: '42', state: 'upcoming', scheduledAt: new Date(start).toISOString(), windowEndsAt: new Date(end).toISOString(),
  launcherWallet: '11111111111111111111111111111111', maxInitialBuyLamports: '500000000', announcedAt: '2026-10-14T12:00:00Z', announcedBy: 'maintainer' }

test('schedule crosses exact boundaries without claiming a launch occurred', () => {
  assert.deepEqual(launchWindow(schedule, start - 1), { state: 'upcoming', label: 'Launch scheduled', remaining: '0h 0m 1s' })
  assert.equal(launchWindow(schedule, start - 90061_000).remaining, '1d 1h 1m 1s')
  assert.deepEqual(launchWindow(schedule, start), { state: 'open', label: 'Scheduled launch window open', remaining: '1h 0m 0s' })
  assert.equal(launchWindow(schedule, end - 1).state, 'open')
  assert.deepEqual(launchWindow(schedule, end), { state: 'ended', label: 'Scheduled window ended', remaining: null })
  assert.equal(launchWindow({ ...schedule, cancelledAt: '2026-10-14T13:00:00Z' }, start).state, 'cancelled')
  assert.equal(launchWindow({ ...schedule, launchedMint: 'mint' }, end).state, 'launched')
  assert.equal(launchWindow({ ...schedule, windowEndsAt: 'bad' }, start).state, 'unknown')
  const blocked = html(h(ScheduledLaunchBlocked, { repo: { fullName: 'example/repo' }, schedule }))
  assert.match(blocked, /not a completed launch/)
  assert.match(blocked, /2026-10-15 12:00 UTC/)
  assert.doesNotMatch(blocked, /Check launch availability/)
  const open = html(h(ScheduledWindowNote, { schedule: { ...schedule, state: 'open' } }))
  assert.match(open, /Scheduled launch window open/)
  assert.match(open, /Check launch availability/)
})

test('market decision distinguishes access verification, decline and unreadable evidence', () => {
  const render = props => html(h(MarketDecision, { market: { wasVerified: true }, pulse: null, declined: null, ...props }))
  assert.match(render(), /GitHub admin verified/)
  assert.match(render(), /not endorsement/)
  assert.match(render(), /You can lose your entire trade\./)
  assert.match(render(), /<summary[^>]*>Fine print<\/summary>/, 'the rest of the disclosure is folded, not deleted')
  assert.match(render(), /browser only\. It is not a purchase/)
  assert.match(render(), /Activity evidence is unavailable/)
  assert.match(render({ market: {} }), /Maintainer not verified/)
  assert.match(render({ declined: undefined }), /Maintainer status unavailable/)
  assert.doesNotMatch(render({ declined: {} }), /GitHub admin verified/)
  assert.match(render({ declined: {} }), /Maintainer declined/)
  assert.doesNotMatch(render({ stockPair: true }), /href="#transparency"/)
  assert.match(render({ pulse: { status: 'active' } }), /href="#dev-pulse"/)
})

test('depth compares both sides on one scale and does not turn unknown into zero', () => {
  const rendered = html(h(LiquidityCard, { liquidity: { sampledAt: '2026-10-14T09:00:00Z', venue: 'damm', feeBps: 100,
    profile: { depth: [{ impactPercent: 1, buyLamports: '2000000000', sellLamports: '500000000' },
      { impactPercent: 2, buyLamports: null, sellLamports: '0' }] } } }))
  assert.match(rendered, /Historical depth, not a live quote/)
  assert.match(rendered, /2026-10-14 09:00 UTC/)
  assert.match(rendered, /width:100%/)
  assert.match(rendered, /width:25%/)
  assert.match(rendered, /width:0%/)
  assert.match(rendered, />Unknown</)
  assert.match(rendered, /Fee at sample/)
  assert.match(html(h(LiquidityCard, {})), /does not mean zero liquidity/)
})

test('funnel client is identifier-free, opts out and cannot interrupt actions', () => {
  const sent = [], fetch = async (...args) => { sent.push(args) }
  sendMarketEvent('watch', 'token', { navigator: {}, fetch })
  assert.deepEqual(sent[0], ['/api/market-events', { method: 'POST', body: '{"event":"watch","page":"token"}', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true }])
  for (const navigator of [{ globalPrivacyControl: true }, { doNotTrack: '1' }]) sendMarketEvent('view', 'token', { navigator, fetch })
  assert.equal(sent.length, 1)
  assert.doesNotThrow(() => sendMarketEvent('view', 'token', { navigator: {}, fetch: () => { throw Error('offline') } }))
  for (const body of [{ event: 'view', page: 'token', wallet: 'private' }, { event: 'confirmed', page: 'token' }, { event: 'view', page: '/token/mint' }]) {
    assert.throws(() => parseMarketEvent(JSON.stringify(body)))
  }
})

test('funnel endpoint rejects identifying fields, foreign origins and oversized bodies; honors server privacy headers', async t => {
  t.mock.method(console, 'info', () => {})
  const original = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = 'https://repo.ing'
  t.after(() => { if (original === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = original })
  const post = (body, headers = {}) => POST(new Request('https://repo.ing/api/market-events', { method: 'POST', headers: { origin: 'https://repo.ing', ...headers }, body }))
  assert.equal((await post('{"event":"view","page":"token"}')).status, 204)
  assert.equal((await post('{"event":"view","page":"token","repoId":"42"}')).status, 400)
  assert.equal((await post('x'.repeat(129))).status, 413)
  assert.equal((await post('{}', { origin: 'https://foreign.test' })).status, 403)
  assert.equal((await post('{}', { 'sec-gpc': '1' })).status, 204)
  assert.equal((await post('{}', { dnt: '1' })).status, 204)
  assert.equal(console.info.mock.calls.length, 1)
  assert.deepEqual(JSON.parse(console.info.mock.calls[0].arguments[0]), { kind: 'public_market_funnel', event: 'view', page: 'token' })
})
