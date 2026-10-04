import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { proofFacts } from '../app/lib/home-highlights.mjs'
import { homeMarketTabs } from '../app/lib/market-order.mjs'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const market = (id, volume, { hoursOld = id, promoted = true, ...rest } = {}) => ({ repoId: String(id), mint: `Mint${id}`, fullName: `owner/repo-${id}`, symbol: `R${id}`,
  volume24hLamports: String(volume), indexedAt: new Date(NOW - hoursOld * 3_600_000).toISOString(), promoted, priceSol: null, bondingPercent: 12.5, graduated: false, ...rest })

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

const { HomeProofLine, HomeProofFallback } = await appModule('app/components/home-highlights.jsx')

test('the proof line links the buyback figure to its receipts; the placeholder reserves the line', () => {
  const markup = html(h(HomeProofLine, { facts: [{ id: 'traded', value: '6,962 SOL', label: 'traded' }, { id: 'bought', value: '51.56 SOL', label: 'bought back', href: '/stats#repo-title' }] }))
  assert.equal(markup, '<p class="home-proof"><span><strong>6,962 SOL</strong> traded</span><span><a href="/stats#repo-title"><strong>51.56 SOL</strong> bought back</a></span></p>')
  assert.match(html(h(HomeProofFallback)), /class="home-proof is-loading" aria-hidden="true"/)
})
