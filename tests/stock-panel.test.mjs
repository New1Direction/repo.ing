import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { SOL_UNITS, parseMultiplier, parseShownAmount, rawUnits, shownPercentAmount, shownShortfall, shownUnits, stockUnits,
  stockUsdLabel } from '../app/lib/trade-units.mjs'
import { tradeButtonLabel } from '../app/lib/trade-panel.mjs'
import { UNITS_VALID_SECONDS, clearQuoteAssetInfoCache, quoteAssetInfo, unitsValidSeconds } from '../src/quote-asset-info.mjs'
import { currentMultiplier, multiplierText, scaledConfig } from '../src/scaled-ui-amount.mjs'
import { preflightTrade } from '../src/trade-costs.mjs'
import { marketQuoteView } from '../src/quote-assets.mjs'
import { stockBalance } from '../app/lib/stock-balance.mjs'
import { readLaunchDraft, restoredPair, saveLaunchDraft } from '../app/lib/launch-draft.mjs'

// P6b-2 of stock-paired markets (docs/STOCK_QUOTES.md): the trade panel shows a stock pair's stock as wallets show it.
const { TradePanel } = await appModule('app/components/trade-panel.jsx')
const { TradeResultCard } = await appModule('app/components/trade-result-card.jsx')

const METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const METAX_MINT = JSON.parse(readFileSync(new URL('./fixtures/metax-mint.json', import.meta.url), 'utf8'))
// The METAx mint's ScaledUiAmount config (tests/fixtures/metax-mint.json): 1.002298265651938, then 1.0028515433272898 from
// 2026-09-18 (unix 1789777800).
const SWITCH = 1789777800
const metaxInfo = { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, uiMultiplier: '1.0028515433272898', usdPrice: 712.5 }
const units = stockUnits(metaxInfo)
const quote = { assetId: 'meta-xstock', symbol: 'METAx', name: 'Meta xStock', decimals: 8, mint: METAX }
const market = { repoId: '998887', mint: 'MintStockPanel', pool: 'PoolStockPanel', fullName: 'facebook/docusaurus', symbol: 'DOCUSAURUS' }

test('a stock is shown as wallets show it (raw × multiplier, truncated) and typed amounts convert back rounded down', () => {
  assert.deepEqual(parseMultiplier('1.0028515433272898'), { num: 10028515433272898n, den: 10n ** 16n })
  assert.deepEqual(parseMultiplier('2'), { num: 2n, den: 1n })
  for (const bad of ['', '0', '0.0', '1e-7', '-1', '1.', 'abc', '1234567', null]) assert.throws(() => parseMultiplier(bad), /multiplier/, String(bad))
  assert.equal(shownUnits('100000000', units), '100285154')
  assert.equal(rawUnits('100285154', units), '99999999')
  // One whole METAx as a wallet shows it costs fewer raw units, and never shows as more than was typed.
  assert.equal(parseShownAmount('1', units), '99715656')
  assert.equal(shownUnits('99715656', units), '99999999')
  assert.throws(() => parseShownAmount('0.00000001', { ...units, scale: parseMultiplier('2') }), /positive amount/)
  assert.throws(() => parseShownAmount('1.123456789', units), /at most 8 decimal places/)
  // SOL markets are unscaled: exactly the amounts they always had.
  assert.equal(parseShownAmount('0.5', SOL_UNITS), '500000000')
  assert.equal(shownUnits('123', SOL_UNITS), '123')
  assert.equal(stockUnits({ ...metaxInfo, uiMultiplier: '1e-7' }), null)
  assert.equal(stockUnits({ ...metaxInfo, decimals: 'eight' }), null)
  assert.deepEqual(stockUnits({ ...metaxInfo, usdPrice: 1 }), units, 'the price is not part of the units')
})

test('stock presets never spend more than the balance; shortfalls never read smaller than they are', () => {
  for (const balance of ['100000000', '1', '987654321', '3']) {
    for (const percent of [25, 50, 100]) {
      const text = shownPercentAmount(balance, percent, units), part = BigInt(balance) * BigInt(percent) / 100n
      // No preset for dust that would convert back to nothing; every preset offered is spendable and within the balance.
      if (!text) { assert.equal(rawUnits(shownUnits(part, units), units), '0', `${percent}% of ${balance}`); continue }
      const spent = BigInt(parseShownAmount(text, units))
      assert.ok(spent > 0n && spent <= part, `${percent}% of ${balance}`)
    }
  }
  assert.equal(shownPercentAmount('100000000', 100, units), '1.00285154')
  assert.equal(shownPercentAmount('3', 25, units), '')
  assert.equal(shownPercentAmount('1', 100, units), '', 'one raw unit shows as 0.00000001 but converts back to nothing')
  assert.throws(() => shownPercentAmount('100', 10, units), /Unsupported/)
  assert.equal(shownShortfall('1', units), '0.000001')
  assert.equal(shownShortfall('12345678', units), '0.123809')
  assert.equal(shownShortfall('100000000', units), '1.002852')
  assert.equal(stockUsdLabel('100000000', units, 712.5), '$712.50')
  for (const price of [null, undefined, 0, -1, NaN]) assert.equal(stockUsdLabel('100000000', units, price), null, String(price))
  assert.equal(stockUsdLabel(null, units, 712.5), null)
  assert.equal(stockUsdLabel('100000000', null, 712.5), null)
})

test('the trade button names the stock a buy spends, and SOL only for network costs', () => {
  const base = { direction: 'buy', symbol: 'DOCUSAURUS', quoteSymbol: 'METAx', validAmount: true }
  assert.equal(tradeButtonLabel({ ...base, buyExceedsBalance: true }), 'Not enough METAx')
  assert.equal(tradeButtonLabel({ ...base, quoteShortfall: true }), 'Not enough METAx')
  assert.equal(tradeButtonLabel({ ...base, costShortfall: true }), 'Not enough SOL')
  assert.equal(tradeButtonLabel(base), 'Buy DOCUSAURUS')
  assert.equal(tradeButtonLabel({ ...base, direction: 'sell', costShortfall: true }), 'Not enough SOL')
})

test('a market\'s pair for the page: null for SOL, the stock for a stamped market, unavailable when the stamp no longer matches', () => {
  assert.equal(marketQuoteView({ quoteAssetId: null, quoteMint: null }), null)
  assert.deepEqual(marketQuoteView({ quoteAssetId: 'meta-xstock', quoteMint: METAX }), quote)
  assert.deepEqual(marketQuoteView({ quoteAssetId: 'meta-xstock', quoteMint: Keypair.generate().publicKey.toBase58() }), { assetId: 'meta-xstock', unavailable: true })
  assert.deepEqual(marketQuoteView({ quoteAssetId: 'aapl-xstock', quoteMint: METAX }), { assetId: 'aapl-xstock', unavailable: true })
})

const mintAccount = (owner = TOKEN_2022_PROGRAM_ID) => ({ data: Buffer.from(METAX_MINT.data, 'base64'), owner, lamports: 1, executable: false })
const countingConnection = (account = mintAccount) => {
  const connection = { reads: 0, async getAccountInfo(key) { connection.reads++; assert.equal(key.toBase58(), METAX); return account() } }
  return connection
}

test('a stock\'s display facts: the multiplier in force read from its mint, its USD price, the mint kept 30 s, failures never kept', async () => {
  const config = scaledConfig({ multiplier: 1.5, newMultiplier: 2, newMultiplierEffectiveTimestamp: BigInt(SWITCH) })
  assert.deepEqual(config, { multiplier: 1.5, newMultiplier: 2, effectiveAt: SWITCH })
  assert.equal(scaledConfig(null), null)
  assert.equal(currentMultiplier(null, SWITCH), 1)
  assert.equal(currentMultiplier(config, SWITCH - 1), 1.5)
  assert.equal(currentMultiplier(config, SWITCH), 2)
  assert.equal(multiplierText(1.5), '1.5')
  for (const bad of [1e-7, 0, -1, NaN, Infinity, 1e21]) assert.throws(() => multiplierText(bad), /multiplier/, String(bad))
  // Units hold until a scheduled change, at most UNITS_VALID_SECONDS.
  assert.equal(unitsValidSeconds(config, SWITCH - 60), 60)
  assert.equal(unitsValidSeconds(config, SWITCH - 1), 1)
  assert.equal(unitsValidSeconds(config, SWITCH), UNITS_VALID_SECONDS)
  assert.equal(unitsValidSeconds(config, SWITCH - 10_000), UNITS_VALID_SECONDS)
  assert.equal(unitsValidSeconds(null, SWITCH), UNITS_VALID_SECONDS)

  clearQuoteAssetInfoCache()
  const prices = async () => ({ [METAX]: 712.5 })
  assert.equal(await quoteAssetInfo('sol', { connection: countingConnection(), prices }), null)
  assert.equal(await quoteAssetInfo('aapl-xstock', { connection: countingConnection(), prices }), null)
  const connection = countingConnection(), after = () => (SWITCH + 60) * 1000
  assert.deepEqual(await quoteAssetInfo('meta-xstock', { connection, prices, now: after }),
    { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, uiMultiplier: '1.0028515433272898', validForSeconds: UNITS_VALID_SECONDS, usdPrice: 712.5 })
  await quoteAssetInfo('meta-xstock', { connection, prices: async () => ({}), now: () => after() + 29_000 })
  assert.equal(connection.reads, 1, 'the mint is kept 30 s')
  assert.equal((await quoteAssetInfo('meta-xstock', { connection, prices: () => Promise.reject(Error('down')), now: () => after() + 30_000 })).usdPrice, null)
  assert.equal(connection.reads, 2)

  // A scheduled change is applied on the second it takes effect, from the kept mint, without waiting for a new read.
  clearQuoteAssetInfoCache()
  const scheduled = countingConnection()
  const before = await quoteAssetInfo('meta-xstock', { connection: scheduled, prices, now: () => (SWITCH - 1) * 1000 })
  assert.deepEqual([before.uiMultiplier, before.validForSeconds], ['1.002298265651938', 1])
  const at = await quoteAssetInfo('meta-xstock', { connection: scheduled, prices, now: () => SWITCH * 1000 })
  assert.deepEqual([at.uiMultiplier, at.validForSeconds, scheduled.reads], ['1.0028515433272898', UNITS_VALID_SECONDS, 1])
  // A price that does not answer never holds up the units.
  const started = Date.now()
  assert.equal((await quoteAssetInfo('meta-xstock', { connection: scheduled, prices: () => new Promise(() => {}), now: () => SWITCH * 1000 })).usdPrice, null)
  assert.ok(Date.now() - started < 2_000)
  clearQuoteAssetInfoCache()
  const failing = { async getAccountInfo() { throw Error('rpc down') } }
  await assert.rejects(quoteAssetInfo('meta-xstock', { connection: failing, prices, now: after }), /rpc down/)
  assert.equal((await quoteAssetInfo('meta-xstock', { connection: countingConnection(), prices, now: after })).uiMultiplier, '1.0028515433272898', 'a failure is not kept')
  clearQuoteAssetInfoCache()
  await assert.rejects(quoteAssetInfo('meta-xstock', { connection: countingConnection(() => mintAccount(TOKEN_PROGRAM_ID)), prices, now: after }), /Stock mint is unavailable/)
  clearQuoteAssetInfoCache()
})

test('the server\'s refusal of a stock buy beyond the wallet\'s stock is in the units wallets show, rounded up', async () => {
  clearQuoteAssetInfoCache()
  // 10,000,000 raw × 1.0028515433272898 = 10,028,515.4…, rounded up to 10,028,516, then up to 6 places.
  await assert.rejects(preflightTrade(countingConnection(), null, { quoteMint: METAX, quoteShortfall: '10000000', shortfall: '0' }),
    { message: 'You need approximately 0.100286 more METAx.' })
  clearQuoteAssetInfoCache()
})

const tokenAccount = (owner, amount) => {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode({ mint: new PublicKey(METAX), owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
    isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data)
  return { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 2_074_080, executable: false }
}

test('a wallet\'s stock balance comes from the account stock trades spend from; a failed read is unavailable, never zero', async () => {
  const wallet = Keypair.generate().publicKey, account = getAssociatedTokenAddressSync(new PublicKey(METAX), wallet, false, TOKEN_2022_PROGRAM_ID)
  const connect = info => () => ({ async getAccountInfo(key) { assert.ok(key.equals(account)); return info() } })
  assert.deepEqual(await stockBalance(() => assert.fail('no read for an unknown pair'), wallet, 'sol'), { status: 400, body: { error: 'Unknown pair' } })
  assert.deepEqual(await stockBalance(() => assert.fail('no read for an unknown pair'), wallet, 'nope'), { status: 400, body: { error: 'Unknown pair' } })
  assert.deepEqual(await stockBalance(connect(() => null), wallet, 'meta-xstock'),
    { status: 200, body: { assetId: 'meta-xstock', decimals: 8, balanceBaseUnits: '0' } })
  assert.deepEqual((await stockBalance(connect(() => tokenAccount(wallet, 123_456_789n)), wallet, 'meta-xstock')).body.balanceBaseUnits, '123456789')
  assert.deepEqual(await stockBalance(connect(() => { throw Error('rpc down') }), wallet, 'meta-xstock'),
    { status: 503, body: { error: 'METAx balance is temporarily unavailable' } })
})

test('the panel for a stock pair: METAx units, no amount until its units load, percent presets, no SOL size guide', () => {
  const markup = html(h(TradePanel, { market, quote, available: true }), { wallet: true })
  assert.match(markup, /<span class="trade-unit">METAx<\/span>/)
  assert.match(markup, /<input id="trade-amount" disabled=""/)
  assert.match(markup, /Loading METAx…/)
  assert.match(markup, /aria-label="Buy amount shortcuts"/)
  assert.match(markup, /aria-label="Spend 100% of your METAx balance"/)
  assert.doesNotMatch(markup, /Trade size guide|Buy 0\.1 SOL|Edit buy presets/)
  assert.match(markup, /<button class="button primary trade-submit" type="submit" disabled="">Enter an amount<\/button>/)
  // A graduated stock pair trades in its verified pool, in METAx (src/stock-damm-trade.mjs); without a verified destination it stays
  // closed; a pair that no longer matches the registry is paused.
  const graduated = html(h(TradePanel, { market, quote, available: true, curve: { status: 'graduated', destination: { url: 'https://app.meteora.ag/dammv2/PoolStockPanel' } } }), { wallet: true })
  assert.match(graduated, /<p class="trade-venue">Trades in the graduated Meteora pool/)
  assert.match(graduated, /<span class="trade-unit">METAx<\/span>/)
  assert.match(graduated, /aria-label="Spend 100% of your METAx balance"/)
  assert.doesNotMatch(graduated, /not open here yet|Trade size guide/)
  assert.match(html(h(TradePanel, { market, quote, available: true, curve: { status: 'graduated' } }), { wallet: true }), /We are checking the destination pool/)
  assert.match(html(h(TradePanel, { market, quote: { assetId: 'meta-xstock', unavailable: true }, available: true }), { wallet: true }), /Trading unavailable/)
  // SOL markets keep their SOL presets and size guide.
  const sol = html(h(TradePanel, { market, available: true }), { wallet: true })
  assert.match(sol, /Edit buy presets/)
  assert.match(sol, /Trade size guide/)
  assert.doesNotMatch(sol, /METAx|Loading/)
})

test('a confirmed stock sell reports the stock received as wallets show it; a SOL sell is unchanged', () => {
  const result = { state: 'confirmed', direction: 'sell', signature: `${'5'.repeat(86)}A`, tokenDelta: '-5000000', solDelta: '-5000',
    quoteDelta: '10000000', quoteMint: METAX, feeIndexing: 'recorded' }
  const card = props => html(h(TradeResultCard, { result, symbol: 'DOCUSAURUS', mint: 'MintStockPanel', fullName: 'facebook/docusaurus', onClose() {}, onCheck() {}, ...props }))
  assert.match(card({ quoteUnits: units }), /Received 0\.1002 METAx\./)
  // A SOL sell smaller than its transaction costs: the wallet lost SOL, so the card says so instead of "gained -0.000005".
  assert.match(card({}), /This sale returned less SOL than its transaction costs, so your wallet has 0\.000005 SOL less\./)
  assert.doesNotMatch(card({}), /gained -/)
})

test('a launch draft keeps its pair, restored only while the repository is still offered it', () => {
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  const fields = { name: 'Docusaurus', symbol: 'DOCUSAURUS', choice: 'none', customBuy: '', tokenImage: null }
  saveLaunchDraft(storage, '94911145', { ...fields, quoteAssetId: 'meta-xstock' }, 1_000)
  assert.equal(readLaunchDraft(storage, '94911145', 2_000).quoteAssetId, 'meta-xstock')
  saveLaunchDraft(storage, '94911145', fields, 1_000)
  assert.equal(readLaunchDraft(storage, '94911145', 2_000).quoteAssetId, 'sol', 'a draft without a pair is SOL')
  const saved = JSON.parse(store.get('repoing:launch-draft:v1:94911145'))
  store.set('repoing:launch-draft:v1:94911145', JSON.stringify({ ...saved, quoteAssetId: 'METAx' }))
  assert.equal(readLaunchDraft(storage, '94911145', 2_000), null, 'a ticker is not a pair id')
  assert.deepEqual(restoredPair({ quoteAssetId: 'sol' }, 'meta-xstock'), { quoteAssetId: 'sol', pairDropped: false })
  assert.deepEqual(restoredPair({ quoteAssetId: 'meta-xstock' }, 'meta-xstock'), { quoteAssetId: 'meta-xstock', pairDropped: false })
  assert.deepEqual(restoredPair({ quoteAssetId: 'meta-xstock' }, undefined), { quoteAssetId: 'sol', pairDropped: true })
})
