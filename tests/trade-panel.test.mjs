import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { quoteAmountLabel, tradeButtonLabel } from '../app/lib/trade-panel.mjs'
import { linkedTraders } from '../app/lib/market-activity.mjs'
import { tradeKey, traderHandles } from '../app/lib/recent-trades.mjs'

const { TradePanel } = await appModule('app/components/trade-panel.jsx')
const { TradeIdentity } = await appModule('app/components/trade-identity.jsx')
const { TradeResultCard } = await appModule('app/components/trade-result-card.jsx')
const { RecentTradeRow } = await appModule('app/components/recent-trades.jsx')

const SIGNATURE = `${'5'.repeat(86)}A`
const LINK = { username: 'builder_jo', name: 'Jo', image: 'https://pbs.twimg.com/profile_images/1/jo.jpg' }
const market = { repoId: '998887', mint: 'MintTradePanel', pool: 'PoolTradePanel', fullName: 'local/preview', symbol: 'WTR' }

test('quote amounts keep the precision that matters: 2 decimals from 1,000, 4 from 1, up to 6 below, never rounded up', () => {
  assert.equal(quoteAmountLabel('1146160980723', 6), '1,146,160.98')
  assert.equal(quoteAmountLabel('1000000000000', 6), '1,000,000')
  assert.equal(quoteAmountLabel('123456789', 6), '123.4567')
  assert.equal(quoteAmountLabel('1234567', 6), '1.2345')
  assert.equal(quoteAmountLabel('123456', 6), '0.123456')
  assert.equal(quoteAmountLabel('59970000000', 9), '59.97')
  assert.equal(quoteAmountLabel('961234567', 9), '0.961234')
  assert.equal(quoteAmountLabel('500', 9), '<0.000001')
  assert.equal(quoteAmountLabel('0', 9), '0')
  assert.equal(quoteAmountLabel(null, 6), '—')
})

test('the trade button says what is missing before it says Buy or Sell', () => {
  const base = { direction: 'buy', symbol: 'WTR', validAmount: true }
  assert.equal(tradeButtonLabel({ ...base, validAmount: false }), 'Enter an amount')
  assert.equal(tradeButtonLabel({ ...base, buyExceedsBalance: true }), 'Not enough SOL')
  assert.equal(tradeButtonLabel({ ...base, costShortfall: true }), 'Not enough SOL')
  assert.equal(tradeButtonLabel(base), 'Buy WTR')
  assert.equal(tradeButtonLabel({ ...base, direction: 'sell', sellExceedsBalance: true }), 'Not enough WTR')
  assert.equal(tradeButtonLabel({ ...base, direction: 'sell', costShortfall: true }), 'Not enough SOL')
  assert.equal(tradeButtonLabel({ ...base, direction: 'sell' }), 'Sell WTR')
})

test('recent trades name a trader only by a linked X account, by trade, with no wallet address', () => {
  const rows = [{ signature: 'a', eventIndex: 0, trader: 'WalletLinked' }, { signature: 'b', eventIndex: 1, trader: 'WalletPlain' },
    { signature: 'c', eventIndex: 2, trader: null }, { signature: 'd', eventIndex: 0, trader: 'WalletLinked' }]
  const handles = new Map([['WalletLinked', { wallet: 'WalletLinked', ...LINK, verified: false, linkedAt: '2026-10-01T00:00:00Z' }]])
  const traders = linkedTraders(rows, handles)
  assert.deepEqual(traders, [{ signature: 'a', eventIndex: 0, x: LINK }, { signature: 'd', eventIndex: 0, x: LINK }])
  assert.doesNotMatch(JSON.stringify(traders), /Wallet/)
})

test('the client keeps only well-formed trader handles, keyed the way chart trades are', () => {
  const handles = traderHandles({ traders: [{ signature: SIGNATURE, eventIndex: 3, x: LINK }, { signature: 'bad', eventIndex: 0, x: LINK },
    { signature: SIGNATURE, eventIndex: 4, x: { username: 'not a handle!' } }, null] })
  assert.deepEqual([...handles.keys()], [`${SIGNATURE}:3`])
  assert.equal(handles.get(tradeKey({ signature: SIGNATURE, eventIndex: 3 })), LINK)
  assert.equal(traderHandles(null).size, 0)
  assert.equal(traderHandles({ traders: 'nope' }).size, 0)
})

test('a linked buyer appears in Recent trades as @handle; other rows are unchanged', () => {
  const trade = { signature: SIGNATURE, eventIndex: 0, direction: 'buy', tradedAt: '2026-10-01T11:58:00Z', solLamports: '256300000', tokenBaseUnits: '589127440000' }
  const now = Date.parse('2026-10-01T12:00:00Z')
  const linked = html(h(RecentTradeRow, { trade, symbol: 'WTR', now, x: LINK }))
  assert.match(linked, /href="https:\/\/x.com\/builder_jo"/)
  assert.match(linked, /@builder_jo/)
  assert.match(linked, /0.2563 SOL/)
  const plain = html(h(RecentTradeRow, { trade, symbol: 'WTR', now }))
  assert.doesNotMatch(plain, /x\.com/)
  assert.match(plain, /589,127.44 WTR/)
})

test('trading as: the linked @handle, else a Connect X prompt, and nothing before the wallet\'s link is known', () => {
  const linked = html(h(TradeIdentity, { wallet: 'Wallet1', direction: 'buy', x: { known: true, off: false, link: LINK } }))
  assert.match(linked, /Buying as/)
  assert.match(linked, /@builder_jo/)
  assert.match(html(h(TradeIdentity, { wallet: 'Wallet1', direction: 'sell', x: { known: true, off: false, link: LINK } })), /Selling as/)
  const prompt = html(h(TradeIdentity, { wallet: 'Wallet1', direction: 'buy', x: { known: true, off: false, link: null } }))
  assert.match(prompt, /href="\/wallet#x-account"/)
  assert.match(prompt, /show your @handle/)
  for (const props of [{ wallet: null, x: { known: true, off: false, link: null } }, { wallet: 'Wallet1', x: { known: false, off: false, link: null } },
    { wallet: 'Wallet1', x: { known: true, off: true, link: null } }]) assert.equal(html(h(TradeIdentity, { direction: 'buy', ...props })), '')
})

test('a confirmed buy shows the @handle it appears as, or the Connect X prompt; other states show neither', () => {
  const result = { state: 'confirmed', direction: 'buy', signature: SIGNATURE, tokenDelta: '589127440000', feeIndexing: 'recorded' }
  const card = props => html(h(TradeResultCard, { result, symbol: 'WTR', mint: 'MintTradePanel', fullName: 'local/preview', onClose() {}, onCheck() {}, ...props }))
  assert.match(card({ xLink: LINK }), /Shown as.*@builder_jo/s)
  assert.match(card({ xNudge: true }), /href="\/wallet#x-account"/)
  assert.doesNotMatch(card({}), /x-account|@builder_jo/)
  assert.doesNotMatch(card({ result: { ...result, state: 'pending' }, xLink: LINK }), /@builder_jo/)
})

test('the panel: amounts in labelled fields, the wallet button in the pay field, one slippage control and a button that asks for an amount', () => {
  const markup = html(h(TradePanel, { market, available: true, usdPerSol: 150 }), { wallet: true })
  assert.match(markup, /<label for="trade-amount">You pay<\/label>/)
  assert.match(markup, /class="trade-field-head"><label for="trade-amount">You pay<\/label><button type="button" class="trade-field-action">Connect wallet<\/button>/)
  assert.match(markup, /aria-label="Switch to selling WTR"/)
  assert.match(markup, /You receive/)
  assert.equal(markup.match(/Max slippage/g).length, 1)
  assert.match(markup, /<button class="button primary trade-submit" type="submit" disabled="">Enter an amount<\/button>/)
  assert.doesNotMatch(markup, /Leave SOL for|Buying as|trade-venue/)
  const graduated = html(h(TradePanel, { market, available: true, curve: { status: 'graduated', destination: { url: 'https://app.meteora.ag/dammv2/PoolTradePanel' } } }), { wallet: true })
  assert.match(graduated, /class="trade-venue">Trades in the graduated Meteora pool/)
  assert.match(graduated, /href="https:\/\/app.meteora.ag\/dammv2\/PoolTradePanel"/)
})
