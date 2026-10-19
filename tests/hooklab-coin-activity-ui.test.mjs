// The Hooks coin page's chart and its Trades and Holders tabs, server-rendered: friendly empty states, readable rows
// (time, side, SOL, coins, a short wallet linked to the explorer), holders with their share of supply, and the page
// order phones stack (coin, trade panel, chart, activity, Blocks).
import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { appendOlderTrades, mergeTradePage } from '../app/lib/hooklab-coin-display.mjs'

const { HookTradesList, HookHoldersList, HookCoinActivity } = await appModule('app/components/hooklab-coin-activity.jsx')
const { HookCoinChart } = await appModule('app/components/hooklab-coin-chart.jsx')
const trader = 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9'
const buy = { signature: '5LPRXLDZgBoJAi5KHKo79sWkj4qNEmoVY4J3uXvkg881ULcTH5fBW7E94qqPwbL3pszCcGPUZ4k9XuVSyk4Dvki9', eventIndex: 10, side: 'buy', trader,
  tradedAt: '2026-10-18T20:48:51.000Z', solLamports: '1000200', tokenBaseUnits: '1112870787571', swapCount: '1' }
const sell = { ...buy, signature: '3PBoq892dSnBTmKJvgqLCqoaXtgmhiZjkMq5ozTpA6cDpn5pw7naoFjEZroAtJ1Jtpe7qQC4kvAd1e5cdcxevJbx', side: 'sell', solLamports: '980295',
  tradedAt: '2026-10-18T20:49:37.000Z', swapCount: '2' }
const now = Date.parse('2026-10-18T20:52:00Z')
const curve = { rank: null, owner: '7Cpg9Z7cd8nN46CiuwAeyzKNUh6E7cjroaoyDt219YxT', holding: 'G13vXkYb82PYqQ2xbpPChfZuqEXAN12WsQ2Qc4bBvmN2', amount: '750000000000000', percent: 75, label: 'Bonding curve' }
const reserve = { rank: null, owner: '5jVDpPwtbTYixQbquSWWeudDR3dLDjfLbUvVevbjM3M6', holding: 'G5R18mtJVRbjCSHCBTs5TKkGYDNFYKwSVVX5Q1BnGEX8', amount: '250000000000000', percent: 25, label: 'Launch reserve' }
const holder = { rank: 1, owner: trader, holding: '2ypvxJ21suPL8ikQj7dk7gb62AaHBCh6H3nr3UevKW7B', amount: '12345678000000', percent: 1.2345, label: null }

test('trades: a friendly empty state, then readable rows with explorer links', () => {
  const empty = html(h(HookTradesList, { trades: [], symbol: 'TEST', decimals: 6, now }))
  assert.match(empty, /role="status"[^>]*>.*No trades yet\. Be the first\./s)
  const list = html(h(HookTradesList, { trades: [sell, buy], symbol: 'TEST', decimals: 6, now, more: true, syncing: 1 }))
  for (const text of [/<th[^>]*>Time<\/th>/, /<th[^>]*>SOL<\/th>/, /<th[^>]*>\$TEST<\/th>/, /<th[^>]*>Wallet<\/th>/, />Buy</, />Sell</, />0\.001</, />0\.00098</, /1\.11M/, /DkD5…J9g9/, />3m</, />2m</,
    /Show older trades/, /1 new trade is confirming/]) assert.match(list, text)
  assert.match(list, new RegExp(`href="https://explorer\\.solana\\.com/tx/${buy.signature}"`))
  assert.match(list, new RegExp(`href="https://explorer\\.solana\\.com/address/${trader}"`))
  assert.ok(list.indexOf(sell.signature) < list.indexOf(buy.signature), 'newest first, as the API orders them')
  assert.doesNotMatch(list, /base units|lamports|swapCount/)
  assert.match(html(h(HookTradesList, { trades: null, symbol: 'TEST', decimals: 6, now })), /aria-busy="true"/)
  assert.match(html(h(HookTradesList, { trades: null, failed: true, symbol: 'TEST', decimals: 6, now })), /Trades are taking a moment/)
})

test('holders: the curve and reserve named, then ranked wallets with their share', () => {
  const list = html(h(HookHoldersList, { data: { holderCount: 1, holders: [curve, reserve, holder] }, symbol: 'TEST', decimals: 6 }))
  for (const text of [/Bonding curve/, /Launch reserve/, />75%</, />25%</, />1\.23%</, /DkD5…J9g9/, /12\.35M/, /1 holder\b/, /<th[^>]*>Share<\/th>/]) assert.match(list, text)
  assert.ok(list.indexOf('Bonding curve') < list.indexOf('DkD5…J9g9'))
  const empty = html(h(HookHoldersList, { data: { holderCount: 0, holders: [curve, reserve] }, symbol: 'TEST', decimals: 6 }))
  assert.match(empty, /No holders yet\. Be the first\./); assert.match(empty, /Bonding curve/)
  assert.match(html(h(HookHoldersList, { data: null, symbol: 'TEST', decimals: 6 })), /aria-busy="true"/)
})

test('the activity card: Trades and Holders tabs, trades first', () => {
  const card = html(h(HookCoinActivity, { mint: 'm', symbol: 'TEST', decimals: 6 }))
  assert.match(card, /role="tablist"[^>]*aria-label="\$TEST activity"/)
  assert.match(card, /role="tab"[^>]*aria-selected="true"[^>]*>Trades</); assert.match(card, /role="tab"[^>]*aria-selected="false"[^>]*>Holders</)
  assert.match(html(h(HookCoinActivity, { mint: 'm', symbol: 'TEST', decimals: 6, initialTrades: { trades: [], next: null, syncing: 0 } })), /No trades yet\. Be the first\./)
})

test('the chart: loading, empty, then market cap in SOL with every candle size', () => {
  const props = { mint: 'm', symbol: 'TEST', decimals: 6, supply: '1000000000000000' }
  assert.match(html(h(HookCoinChart, props)), /Loading prices/)
  const empty = html(h(HookCoinChart, { ...props, initial: { interval: '15m', intervalSeconds: 900, decimals: 6, syncing: 0, totalTrades: 0, volume24hLamports: '0',
    firstTradeAt: null, lastTradeAt: null, latest: null, candles: [] } }))
  assert.match(empty, /No trades yet\. Be the first\./)
  const chart = html(h(HookCoinChart, { ...props, initial: { interval: '15m', intervalSeconds: 900, decimals: 6, syncing: 0, totalTrades: 2, volume24hLamports: '1980495',
    firstTradeAt: '2026-10-18T20:48:51.000Z', lastTradeAt: '2026-10-18T20:49:37.000Z', latest: { priceSol: 0.000000000889, tradedAt: '2026-10-18T20:49:37.000Z' },
    candles: [{ time: 1792356300, open: 0.00000000089, high: 0.00000000089, low: 0.000000000889, close: 0.000000000889, volumeLamports: '1980495', count: 2 }] } }))
  for (const text of [/aria-label="\$TEST price chart"/, /Market cap · SOL/, /0\.889 SOL/, /0\.00198 SOL/, /24h volume/, />2</, /Preparing chart/]) assert.match(chart, text)
  for (const label of ['1m', '5m', '15m', '1H', '4H', '1D']) assert.match(chart, new RegExp(`<button[^>]*>${label}</button>`))
  assert.match(chart, /aria-pressed="true"[^>]*>15m</); assert.match(chart, /aria-pressed="true"[^>]*>MCap</)
  assert.doesNotMatch(chart, /USD/)
})

test('coin page: a listed coin gets the chart and the activity tabs, in phone order', async () => {
  const { default: Token } = await appModule('app/(site)/hooks/token/[mint]/page.jsx')
  const { cached } = await appModule('app/lib/hooklab-market.mjs')
  const mint = '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn', key = Symbol.for('repo.ing.hooklab.inclusive-trade-runtime')
  const market = { mint, name: 'Hook Lab Canary', symbol: 'HLCANARY', uri: '', decimals: 6, observedSlot: 1, creator: trader, graduated: false, capBps: 200, creatorFeeBps: 100,
    initialSupply: '1000000000000000', supply: '1000000000000000', capRaw: '20000000000000', marketCapLamports: '888888888', graduationQuote: '2000000000', curveProgressBps: 0,
    pool: { baseReserve: '750000000000000', quoteReserve: '1', virtualBase: '375000000000000', virtualQuote: '1000000000', protocolFeesQuote: '0', swapCount: '2' } }
  // Another Hooks coin, opened by address but not launched through repo.ing (no launch request behind it).
  const other = 'FESS7xFpE9wzH4Kq8zbKztRNv1iFWQm9gwpsyhAkUJN1'
  globalThis[key] = { market: async requested => [mint, other].includes(requested) ? { market: { ...market, mint: requested }, wallet: null } : null }
  try {
    cached(`profile:${mint}`, 60_000, () => ({ id: '00000000-0000-4000-8000-000000000000', name: 'Hook Lab Canary', symbol: 'HLCANARY', creator: trader, profile: null }))
    const unlisted = html(await Token({ params: Promise.resolve({ mint: other }) }), { wallet: true })
    assert.match(unlisted, /Blocks on this coin/)
    assert.doesNotMatch(unlisted, /price chart|activity"|has-activity/, 'coins not launched through repo.ing get no index')
    const page = html(await Token({ params: Promise.resolve({ mint }) }), { wallet: true })
    const at = text => page.indexOf(text)
    const [hero, panel, chart, activity, blocks] = ['Hook Lab Canary', 'aria-label="Trade $HLCANARY"', 'aria-label="$HLCANARY price chart"', 'aria-label="$HLCANARY activity"', 'Blocks on this coin'].map(at)
    assert.ok(hero >= 0 && hero < panel && panel < chart && chart < activity && activity < blocks, `order ${[hero, panel, chart, activity, blocks]}`)
    assert.match(page, /class="hooks-coin-layout has-activity"/)
  } finally { delete globalThis[key] }
})

test('older trades stay joined to a refreshed first page, with nothing silently skipped', () => {
  const rows = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => ({ signature: `s${from - i}`, eventIndex: 0, swapCount: String(from - i) }))
  const counts = list => [list.trades[0].swapCount, list.trades.at(-1).swapCount, list.trades.length, list.next]
  let shown = mergeTradePage(null, { trades: rows(100, 81), next: '81' })
  shown = appendOlderTrades(shown, { trades: rows(80, 61), next: '61' })
  assert.deepEqual(counts(shown), ['100', '61', 40, '61'])
  // Five new trades: the refreshed page overlaps what is shown, so 85..81 stay.
  shown = mergeTradePage(shown, { trades: rows(105, 86), next: '86' })
  assert.deepEqual(counts(shown), ['105', '61', 45, '61'])
  // Thirty new trades: 110..106 were never fetched, so the list starts again from the refreshed page.
  shown = mergeTradePage(shown, { trades: rows(135, 116), next: '116' })
  assert.deepEqual(counts(shown), ['135', '116', 20, '116'])
  assert.deepEqual(counts(mergeTradePage(shown, { trades: rows(135, 116), next: '116' })), ['135', '116', 20, '116'], 'a repeat changes nothing')
})

test('while older history is still being read, the trades list says so', () => {
  assert.match(html(h(HookTradesList, { trades: [sell], symbol: 'TEST', decimals: 6, now, backfilling: true })), /Older trades are still loading/)
})
