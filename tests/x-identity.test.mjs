import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { activityEvents } from '../app/lib/market-activity.mjs'

const { WalletIdentity } = await appModule('app/components/wallet-identity.jsx')
const { readXLink } = await appModule('app/components/x-link-state.jsx')

const WALLET = 'Backer111111111111111111111111111111111111x'
const LINK = { wallet: WALLET, username: 'alice_dev', name: 'Alice', image: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg', verified: false }

test('a wallet that linked X shows as that account: avatar and @handle, with the address only behind the Solscan link', () => {
  const markup = html(h(WalletIdentity, { wallet: WALLET, link: LINK }))
  assert.match(markup, /^<span class="wallet-identity has-x">/)
  assert.match(markup, /<a class="x-handle" href="https:\/\/x\.com\/alice_dev"/)
  assert.match(markup, /<img src="https:\/\/pbs\.twimg\.com\/profile_images\/1\/a_normal\.jpg"/)
  assert.match(markup, /<span>@alice_dev<\/span>/)
  assert.ok(!markup.includes('copy-address'), 'no address chip')
  assert.match(markup, new RegExp(`<a class="wallet-identity-solscan" href="https://solscan.io/account/${WALLET}"[^>]*title="${WALLET}"`))
})

test('without a usable link the short copyable address is shown, as before', () => {
  for (const link of [null, { ...LINK, username: 'not a handle!' }, {}]) {
    const markup = html(h(WalletIdentity, { wallet: WALLET, link, label: 'discoverer wallet' }))
    assert.match(markup, /^<span class="wallet-identity">/)
    assert.match(markup, /<code>Backer11…11111x<\/code>/)
    assert.match(markup, /aria-label="Copy full discoverer wallet Backer1/)
    assert.ok(!markup.includes('x-handle'))
  }
})

test('the maintainer check appears only for a trusted wallet; an avatar off X\'s image host is never used', () => {
  assert.match(html(h(WalletIdentity, { wallet: WALLET, link: LINK, trust: true })), /class="x-handle-check" aria-label="verified maintainer">✓/)
  assert.ok(!html(h(WalletIdentity, { wallet: WALLET, link: LINK })).includes('x-handle-check'))
  const offHost = html(h(WalletIdentity, { wallet: WALLET, link: { ...LINK, image: 'https://example.com/a.png' } }))
  assert.ok(!offHost.includes('<img'), 'falls back to the X mark')
})

test('activity: a trade names its trader only by a linked X account, never by address; pool and curve trades merge newest first', () => {
  const at = minute => new Date(Date.UTC(2026, 9, 3, 12, minute))
  const trades = [
    { direction: 'buy', signature: 'curve', eventIndex: 0, occurredAt: at(1), inputBaseUnits: '1000000000', outputBaseUnits: '5000000', trader: WALLET },
    { direction: 'sell', signature: 'pool', eventIndex: 2, occurredAt: at(5), inputBaseUnits: '7000000', outputBaseUnits: '300000000', trader: 'Unlinked1111111111111111111111111111111111' },
  ]
  const events = activityEvents({ trades, fees: [{ signature: 'fee', eventIndex: 1, occurredAt: at(3), amountBaseUnits: '1000' }],
    handles: new Map([[WALLET, LINK]]) })
  assert.deepEqual(events.map(event => event.signature), ['pool', 'fee', 'curve'])
  assert.deepEqual(events[2], { type: 'buy', signature: 'curve', eventIndex: 0, occurredAt: at(1).toISOString(), inputBaseUnits: '1000000000',
    outputBaseUnits: '5000000', x: { username: 'alice_dev', name: 'Alice', image: LINK.image } })
  assert.equal(events[0].x, undefined)
  assert.ok(!JSON.stringify(events).includes(WALLET) && !JSON.stringify(events).includes('Unlinked1'), 'no wallet address leaves the API')
  assert.equal(activityEvents({ trades: Array.from({ length: 50 }, (_, i) => ({ ...trades[0], signature: `t${i}`, occurredAt: at(i) })) }).length, 40)
})

test('header X lookup: 404 means Connect X is off; otherwise the wallet\'s link or null; other failures throw', async () => {
  const reply = (status, body) => async url => { assert.equal(url, `/api/x/link?wallet=${WALLET}`); return new Response(JSON.stringify(body), { status }) }
  assert.deepEqual(await readXLink(WALLET, reply(404, { error: 'Not found' })), { off: true, link: null })
  assert.deepEqual(await readXLink(WALLET, reply(200, { link: LINK, pending: null })), { off: false, link: LINK })
  assert.deepEqual(await readXLink(WALLET, reply(200, { link: null, pending: null })), { off: false, link: null })
  await assert.rejects(readXLink(WALLET, reply(503, { error: 'down' })), /X link unavailable/)
})
