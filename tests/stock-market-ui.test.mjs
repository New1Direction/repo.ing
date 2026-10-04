import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html, offlineFetch } from './fixtures/render-jsx.mjs'
import { stockDisplayUnits } from '../app/lib/stock-display.mjs'

// Stock pairs on the page (docs/STOCK_QUOTES.md), server-rendered: the /stats section, the graduation bar, list rows, the
// more-markets strip, the phone summary and the activity heading show a stock pair in its stock, as wallets show it, and in
// USD at its own price; SOL markets render their SOL figures as before.
const { StockPairTable } = await appModule('app/components/stock-pair-table.jsx')
const { GraduationProgress } = await appModule('app/components/graduation-progress.jsx')
const { MarketTable } = await appModule('app/components/ui.jsx')
const { MoreMarkets } = await appModule('app/components/more-markets.jsx')
const { PhoneMarketSummary } = await appModule('app/components/phone-market-summary.jsx')
const { ActivityFeed } = await appModule('app/components/activity-feed.jsx')

const INFO = { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, uiMultiplier: '1.0028515433272898', validForSeconds: 120, usdPrice: 712.5 }
const METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const quote = { assetId: 'meta-xstock', symbol: 'METAx', name: 'Meta xStock', decimals: 8, mint: METAX }
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

test('/stats stock section: each stock in its own units with a USD estimate; a stock without units shows —', () => {
  const data = { range: '24h', hasActivity: true, assets: [
    { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, mint: METAX, markets: 2, trades: 3, volume: '440000000', fees: '701400', launcher: '150300', accumulator: '551100', active: true },
    { assetId: 'msft-xstock', symbol: 'MSFTx', decimals: 8, mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', markets: 1, trades: 1, volume: '250000000', fees: '597', launcher: '150', accumulator: '447', active: true },
  ] }
  const page = text(html(h(StockPairTable, { data, units: { [`meta-xstock:${METAX}`]: stockDisplayUnits(INFO),
    // Units are keyed by asset and mint: another row of the same asset id never borrows them.
    'meta-xstock:SomeOtherMint1111111111111111111111111111': stockDisplayUnits({ ...INFO, uiMultiplier: '2' }) } })))
  assert.match(page, /Stock-paired markets/)
  assert.match(page, /METAx 2 markets · 3 trades 4\.41 METAx ≈ \$3,135\.00 0\.007034 METAx ≈ \$5\.00 0\.001507 METAx ≈ \$1\.07 0\.005527 METAx ≈ \$3\.93/)
  assert.match(page, /MSFTx 1 market · 1 trade — — — —/)
  assert.match(page, /Past 24 hours · .* A stock whose units cannot be read right now shows —\./)
  assert.doesNotMatch(page, /SOL figures above\b.*\d SOL|lamports/i)
})

test('/stats stock section: nothing without a database or before any stock activity; a failed read shows as unavailable', async () => {
  const { StockPairStats } = await appModule('app/components/stock-pair-stats.jsx')
  const saved = process.env.DATABASE_URL
  try {
    delete process.env.DATABASE_URL
    assert.equal(await StockPairStats({ range: 'all' }), null)
    process.env.DATABASE_URL = 'postgres://stock-ui-test.invalid/db'
    const queries = []
    globalThis.__gitfunPool = { connect: async () => ({ release() {}, async query(sql) { queries.push(sql); return { rows: [] } } }) }
    assert.equal(await StockPairStats({ range: '7d' }), null, 'no stock pair has traded: no section')
    assert.ok(queries.some(sql => /from stock_trade_events/.test(sql)))
    // With activity but no RPC (offline), the section still renders, with — for amounts it cannot convert.
    const offline = offlineFetch(); process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
    globalThis.__gitfunPool = { connect: async () => ({ release() {}, async query(sql) {
      return /from stock_trade_events/.test(sql) ? { rows: [{ assetId: 'meta-xstock', quoteMint: METAX, markets: 1, trades: 1, volume: '100000000', fees: '1',
        launcher: '0', accumulator: '1', active: true }] } : { rows: [] } } }) }
    try { assert.match(text(html(await StockPairStats({ range: 'all' }))), /METAx 1 market · 1 trade — — — —/) } finally { offline.restore() }
    // A failed read is never shown as "no stock activity": the section says the totals are unavailable.
    globalThis.__gitfunPool = { connect: async () => ({ release() {}, async query(sql) { if (/from stock_trade_events/.test(sql)) throw Error('canceling statement'); return { rows: [] } } }) }
    assert.match(text(html(await StockPairStats({ range: '30d' }))), /Stock-pair totals are temporarily unavailable/)
  } finally {
    globalThis.__gitfunPool = undefined
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved
  }
})

test('graduation bar: a stock pair\'s progress in its stock once its units load; the percent never waits for them', () => {
  const curve = { quote: { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8 }, phase: 'CURVE', status: 'active', reserve: '3000000000', threshold: '10000000000',
    remaining: '7000000000', progressPercent: 30, checkedAt: '2026-10-04T12:00:00.000Z', validUntil: '2026-10-04T12:05:00.000Z', destination: null }
  const shown = text(html(h(GraduationProgress, { curve, units: INFO })))
  assert.match(shown, /30\.00% 70\.2 METAx to go/)
  assert.match(shown, /METAx held in the curve: 30\.09 METAx \/ 100\.29 METAx/)
  assert.match(shown, /30\.08554629 METAx \/ 100\.28515433 METAx · 70\.19960803 METAx remaining/)
  assert.doesNotMatch(shown, /SOL/)
  const waiting = text(html(h(GraduationProgress, { curve, units: null })))
  assert.match(waiting, /30\.00%/); assert.doesNotMatch(waiting, /to go/)
  assert.doesNotMatch(text(html(h(GraduationProgress, { curve, units: { ...INFO, assetId: 'msft-xstock' } }))), /to go/, 'another stock\'s units are never used')
  const graduated = html(h(GraduationProgress, { curve: { ...curve, phase: 'GRADUATED', status: 'graduated', destination: { pool: 'DammPool', url: 'https://app.meteora.ag/dammv2/DammPool' } }, units: INFO }))
  assert.match(graduated, /Graduated → Meteora pool/); assert.doesNotMatch(text(graduated), /SOL/)
  // A SOL curve renders as before.
  const sol = text(html(h(GraduationProgress, { curve: { phase: 'CURVE', status: 'active', reserveLamports: '42500000000', thresholdLamports: '85000000000',
    remainingLamports: '42500000000', progressPercent: 50 } })))
  assert.match(sol, /50\.00% 42\.5 SOL to go/)
})

test('market rows and the more-markets strip: a stock pair\'s cap and volume in its stock; SOL rows unchanged', () => {
  const sol = { repoId: '1', mint: 'SolMint1111111111111111111111111111111111', fullName: 'local/alpha', symbol: 'ALPHA', tokenName: 'Alpha', description: 'd',
    volume24hLamports: '2500000000', earned: '30000000', claimed: '0', remaining: '30000000', stars: 5, priceSol: 1e-7, wasVerified: false, indexedAt: new Date() }
  const stock = { repoId: '94911145', mint: 'StockMint11111111111111111111111111111111', fullName: 'facebook/docusaurus', symbol: 'DOCUSAURUS', tokenName: 'Docusaurus',
    description: 'd', volume24hLamports: null, earned: '0', claimed: '0', remaining: '0', stars: 60000, priceSol: null, wasVerified: false, indexedAt: new Date(),
    quoteAssetId: 'meta-xstock', stock: { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8, price: 0.04, volume24h: '140000000', uiMultiplier: INFO.uiMultiplier, usdPrice: 712.5 } }
  const table = html(h(MarketTable, { markets: [sol, stock], usdPerSol: 150 }))
  const [solRow, stockRow] = table.split('class="market-row"').slice(1).map(text)
  assert.match(solRow, /\$15k 2\.5 SOL \$4\.50/); assert.doesNotMatch(solRow, /METAx/)
  assert.match(stockRow, /\$28\.5b 1\.4 METAx — Fees in METAx/); assert.doesNotMatch(stockRow, /SOL/)
  const strip = text(html(h(MoreMarkets, { markets: [{ ...sol, isNew: false }, { ...stock, isNew: false }] })))
  assert.match(strip, /local\/alpha .*24h vol 2\.5 SOL/); assert.match(strip, /facebook\/docusaurus .*24h vol 1\.4 METAx/)
})

test('phone summary and activity heading: a stock pair waits for its units, a SOL market reads as before', () => {
  const stockSummary = text(html(h(PhoneMarketSummary, { mint: 'StockMint', symbol: 'DOCUSAURUS', priceSol: null, volume24hLamports: null, quote,
    stock: { price: 0.04, volume24h: '140000000' } })))
  assert.match(stockSummary, /\$DOCUSAURUS price — .* Market cap — 24h volume —/)
  const solSummary = text(html(h(PhoneMarketSummary, { mint: 'SolMint', symbol: 'ALPHA', priceSol: 1e-7, volume24hLamports: '2500000000' })))
  assert.match(solSummary, /\$ALPHA price 1e-7 SOL|\$ALPHA price 0\.0000001 SOL|\$ALPHA price 1\.000e-7 SOL/)
  assert.match(solSummary, /Market cap 100 SOL 24h volume 2\.5 SOL/)
  assert.match(text(html(h(ActivityFeed, { mint: 'SolMint', symbol: 'ALPHA' }))), /Finalized trades, creator fees, and settled payouts from this market\. Traders who linked X/)
  assert.match(text(html(h(ActivityFeed, { mint: 'StockMint', symbol: 'DOCUSAURUS', quote }))), /fee splits and launcher payouts from this market, in METAx as wallets show it/)
})
