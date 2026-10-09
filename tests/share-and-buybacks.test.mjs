import test from 'node:test'
import assert from 'node:assert/strict'
import { shareText, tokenPageUrl, xShareUrl } from '../app/lib/share-links.mjs'
import { buybackSummary, formatTokenCompact } from '../app/lib/buyback-summary.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS, totalBuybackLamports } from '../app/lib/buyback-receipts.mjs'
import { mergeBuybackReceipts } from '../app/lib/buyback-receipts-db.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'
import { CARD_VERSION_MS, ogCardImageUrl, ogMarketStats, ogStatsTime, ogText, settleWithin } from '../app/lib/og-card.mjs'

const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'

test('X share intent carries the repo, handle and canonical token URL, nothing about the wallet', () => {
  const url = new URL(xShareUrl({ mint: MINT, fullName: 'vercel/next.js', symbol: 'NEXT', kind: 'buy' }))
  assert.equal(url.origin + url.pathname, 'https://x.com/intent/post')
  assert.equal(url.searchParams.get('url'), `https://repo.ing/token/${MINT}`)
  assert.equal(url.searchParams.get('text'), "I just backed vercel/next.js on @repodoting — every trade pays the repo's builders in SOL")
  assert.deepEqual([...url.searchParams.keys()], ['text', 'url'])
})

test('share text adapts to launches and sells, and falls back without a repo name', () => {
  assert.match(shareText({ fullName: 'a/b', kind: 'launch' }), /^I just launched a market for a\/b on @repodoting/)
  assert.match(shareText({ fullName: 'a/b', kind: 'sell' }), /^I'm trading a\/b on @repodoting/)
  assert.match(shareText({ symbol: 'ABC' }), /^I just backed \$ABC on/)
  assert.match(shareText(), /^I just backed an open source repo on/)
  assert.equal(tokenPageUrl('a/b?c'), 'https://repo.ing/token/a%2Fb%3Fc')
})

test('buyback counter totals platform-revenue receipts only, matching /stats', () => {
  const summary = buybackSummary(BUYBACK_RECEIPTS)
  assert.equal(summary.lamports, totalBuybackLamports(BUYBACK_RECEIPTS, 'custody'))
  assert.equal(summary.lamports, '7469505712')
  assert.equal(summary.tokenBaseUnits, '50572757248512')
  assert.equal(summary.count, 4)
  assert.equal(summary.sol, '7.47')
  assert.equal(summary.tokens, '50.57M')
})

test('buyback counter includes worker-detected receipts from the shared merge', () => {
  const detected = { signature: 'Detected2222222222222222222222222222222222222222222222222222222222222222222222222',
    source: 'custody', wallet: BUYBACK_WALLETS.custody, mint: OFFICIAL_TOKEN.mint, spentLamports: '530494288',
    tokenBaseUnits: '1000000000000', at: '2026-09-29T06:00:00.000Z' }
  const summary = buybackSummary(mergeBuybackReceipts([detected]))
  assert.equal(summary.lamports, '8000000000')
  assert.equal(summary.count, 5)
  assert.equal(summary.sol, '8')
})

test('buyback counter falls back to null on empty or invalid receipts', () => {
  assert.equal(buybackSummary([]), null)
  assert.equal(buybackSummary(BUYBACK_RECEIPTS.filter(receipt => receipt.source === 'team')), null)
  assert.equal(buybackSummary([{ ...BUYBACK_RECEIPTS.find(receipt => receipt.source === 'custody'), wallet: 'x' }]), null)
  assert.equal(buybackSummary([{ ...BUYBACK_RECEIPTS.find(receipt => receipt.source === 'custody'), tokenBaseUnits: '-1' }]), null)
  assert.equal(buybackSummary(undefined), null)
})

test('compact token amounts truncate and never overstate', () => {
  assert.equal(formatTokenCompact('50572757248512'), '50.57M')
  assert.equal(formatTokenCompact('999999999'), '999')
  assert.equal(formatTokenCompact('1999999999'), '1.99K')
  assert.equal(formatTokenCompact('100000000000000'), '100M')
  assert.equal(formatTokenCompact('2500000000000000000'), '2,500B')
  assert.equal(formatTokenCompact('0'), '0')
  assert.equal(formatTokenCompact('nope'), '—')
})

test('link preview stats need every input for a USD cap and drop what is missing', () => {
  assert.deepEqual(ogMarketStats({ priceSol: 0.00002, supplyBaseUnits: '1000000000000000', supplyDecimals: 6, usdPerSol: 150 }),
    [{ label: 'Market cap', value: '$3m' }, { label: 'Price', value: '$0.003' }])
  assert.deepEqual(ogMarketStats({ priceSol: 0.00002, supplyBaseUnits: '1000000000000000', supplyDecimals: 6, usdPerSol: null }),
    [{ label: 'Price', value: '0.00002 SOL' }])
  assert.deepEqual(ogMarketStats({ priceSol: 0.00002, usdPerSol: 150 }), [{ label: 'Price', value: '$0.003' }])
  assert.deepEqual(ogMarketStats({ priceSol: null }), [])
  assert.deepEqual(ogMarketStats({ priceSol: Number.NaN }), [])
  assert.deepEqual(ogMarketStats(), [])
})

test('link preview prices are plain decimals, never exponents', () => {
  // The $JUMPER card that X showed with "5.159e-8 SOL".
  assert.deepEqual(ogMarketStats({ priceSol: 5.159e-8, supplyBaseUnits: '1000000000000000', supplyDecimals: 6, usdPerSol: 120 }),
    [{ label: 'Market cap', value: '$6.2k' }, { label: 'Price', value: '$0.000006191' }])
  assert.deepEqual(ogMarketStats({ priceSol: 5.159e-8 }), [{ label: 'Price', value: '0.00000005159 SOL' }])
  for (const stat of ogMarketStats({ priceSol: 3.9e-10, usdPerSol: 100 })) assert.doesNotMatch(stat.value, /e-/)
})

test('the link preview card prints when its figures were read, only beside figures', async () => {
  const { appModule, h, html } = await import('./fixtures/render-jsx.mjs')
  const { MarketCard } = await appModule('app/lib/og-market-card.jsx')
  const market = { symbol: 'JUMPER', fullName: 'KingKongRobotics/jumper', repoId: '1', source: 'github', description: 'A robot crab.' }
  const stats = [{ label: 'Market cap', value: '$42.9k' }, { label: 'Price', value: '$0.00004294' }]
  const card = html(h(MarketCard, { market, logo: null, stats, at: Date.UTC(2026, 9, 9, 1, 12) }))
  assert.ok(card.includes('As of 9 Oct 2026, 01:12 UTC') && card.includes('$0.00004294'))
  assert.ok(!html(h(MarketCard, { market, logo: null, stats })).includes('As of'))
  const empty = html(h(MarketCard, { market, logo: null, stats: [], at: Date.UTC(2026, 9, 9) }))
  assert.ok(!empty.includes('As of') && empty.includes('A robot crab.'))
})

test('link preview cards say when their figures were read and use a card URL that changes over time', () => {
  assert.equal(ogStatsTime(Date.UTC(2026, 9, 8, 23, 4, 59)), '8 Oct 2026, 23:04 UTC')
  assert.equal(ogStatsTime(Date.UTC(2026, 0, 31, 0, 0)), '31 Jan 2026, 00:00 UTC')
  assert.equal(ogStatsTime(Number.NaN), '')
  assert.equal(ogStatsTime(null), '')
  assert.equal(ogStatsTime(undefined), '')
  const page = 'https://repo.ing/token/MintA'
  const at = Date.UTC(2026, 9, 8, 23, 0)
  assert.match(ogCardImageUrl(page, at), /^https:\/\/repo\.ing\/token\/MintA\/opengraph-image\?v=[0-9a-z]+$/)
  assert.equal(ogCardImageUrl(page, at), ogCardImageUrl(page, at + CARD_VERSION_MS - 1))
  assert.notEqual(ogCardImageUrl(page, at), ogCardImageUrl(page, at + CARD_VERSION_MS))
})

test('preview text is collapsed and clipped; slow or failing sources settle to the fallback', async () => {
  assert.equal(ogText('  a\n  b ', 10), 'a b')
  assert.equal(ogText('abcdefghij', 5), 'abcd…')
  assert.equal(ogText(null, 5), '')
  assert.equal(await settleWithin(Promise.resolve(3), 50), 3)
  assert.equal(await settleWithin(Promise.reject(Error('down')), 50, 'fallback'), 'fallback')
  assert.equal(await settleWithin(new Promise(() => {}), 10, 'late'), 'late')
})

test('lifetime buyback summary counts platform and team receipts together', () => {
  const all = buybackSummary(BUYBACK_RECEIPTS, null), custody = buybackSummary(BUYBACK_RECEIPTS)
  assert.equal(all.count, BUYBACK_RECEIPTS.length)
  assert.ok(BigInt(all.lamports) > BigInt(custody.lamports))
})
