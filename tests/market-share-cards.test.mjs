import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import { appModule, h, html, offlineFetch } from './fixtures/render-jsx.mjs'
import { graduationProgress } from '../src/graduation-state.mjs'
import { SHARE_CARD_ERRORS, noPayoutYet, payoutShare, shareCardKinds, shareCardNotOffered } from '../src/market-share.mjs'

// Share cards (app/api/market/[mint]/share-card, app/components/market-share-card.jsx). A market offers its graduation progress
// only while it is on its bonding curve, and a stock pair offers no card (its progress is in its stock; it has no builder
// payout). The dialog asks the route for the first card the market offers and shows tabs only for the ones it offers, so a
// graduated market never sits on "This card is not ready… retry shortly". A market with no payout yet says so, finally. The
// payout card shows one verified receipt, labelled as the latest payout, never a total.
const METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const key = () => Keypair.generate().publicKey.toBase58()
const row = (repoId, extra = {}) => ({ repoId, mint: key(), pool: key(), tokenName: 'Waternot', symbol: 'WTR', indexedAt: new Date(), allocationVersion: null,
  discoveryVersion: null, launcherWallet: key(), verificationBonusLamports: null, quoteAssetId: null, quoteMint: null, owner: 'New1Direction', name: 'Waternot',
  fullName: 'New1Direction/Waternot', description: null, avatarUrl: null, source: 'github', stars: 10, forks: 1, updatedAt: null, githubCreatedAt: null,
  beneficiaryWallet: null, beneficiaryBoundAt: null, beneficiaryMethod: null, earned: '0', claimed: '0', volume24hLamports: '0', wasVerified: false,
  lastSqrtPrice: null, graduationStatus: null, observation: null, graduationError: null, migrationEvidenceHash: null, ...extra })
const CURVE = row('101'), GRADUATED = row('102', { migrationEvidenceHash: 'migrated' }), STOCK = row('103', { quoteAssetId: 'meta-xstock', quoteMint: METAX,
  fullName: 'facebook/docusaurus', owner: 'facebook', name: 'docusaurus' }), STALE = row('104')
const MARKETS = [CURVE, GRADUATED, STOCK, STALE]
// A fresh, verified curve observation (src/market-share.mjs graduationShare checks every field); STALE's is unreconciled.
const observation = market => { const now = new Date().toISOString(); return { status: 'VERIFIED', migration_evidence_hash: null,
  reconciliation: JSON.stringify({ status: market === STALE ? 'MISMATCH' : 'MATCH' }),
  observation: JSON.stringify({ ...graduationProgress('26754064634', '85000000000'), checkedAt: now, chainTime: now, repoId: market.repoId, mint: market.mint, curve: market.pool }) } }

const net = offlineFetch()
const savedUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
globalThis.__gitfunPool = { query: async (sql, params = []) => {
  if (/where m\.mint = \$1/.test(sql)) return { rows: MARKETS.filter(market => market.mint === params[0]) }
  if (/from graduation_observations o/.test(sql)) { const market = MARKETS.find(m => m.repoId === params[0]); return { rows: market ? [observation(market)] : [] } }
  return { rows: [] }
} }
test.after(() => { net.restore(); delete globalThis.__gitfunPool; if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl })

const { GET } = await appModule('app/api/market/[mint]/share-card/route.js')
const card = (market, query = '') => GET(new Request(`https://repo.ing/api/market/${market.mint}/share-card${query}`), { params: Promise.resolve({ mint: market.mint }) })

test('cards offered: graduation progress only on the curve, a payout for SOL markets, nothing for a stock pair', () => {
  assert.deepEqual(shareCardKinds({ graduated: false }), ['graduation', 'payout'])
  assert.deepEqual(shareCardKinds({ graduated: true }), ['payout'])
  assert.deepEqual(shareCardKinds({ migrated: true }), ['payout'], 'a recorded migration counts even while fresh progress is stale')
  assert.deepEqual(shareCardKinds({ quoteAssetId: 'meta-xstock', quoteMint: METAX }), [])
  assert.deepEqual(shareCardNotOffered({ graduated: true }, 'graduation'), { code: SHARE_CARD_ERRORS.CARD_NOT_OFFERED, kinds: ['payout'],
    error: 'This market has graduated, so there is no bonding-curve progress to share. Its latest builder payout can be shared instead.' })
  assert.deepEqual(shareCardNotOffered({ quoteAssetId: 'meta-xstock', quoteMint: METAX }, 'payout'), { code: SHARE_CARD_ERRORS.CARD_NOT_OFFERED, kinds: [],
    error: 'Share cards cover SOL markets only: this market\'s progress is in METAx, and a stock pair has no builder payout to show.' })
  assert.deepEqual(noPayoutYet({}), { code: SHARE_CARD_ERRORS.NO_PAYOUT_YET, kinds: ['graduation', 'payout'],
    error: 'No builder payout yet. This card shows the latest verified payout once a repository admin claims builder fees.' })
  assert.match(noPayoutYet({}, { model: true }).error, /^No payout to the model owner yet\./)
})

test('the payout card is the latest verified payout, labelled so, never a total', () => {
  const market = { repoId: '7', fullName: 'owner/repo', mint: 'Mint7' }
  const settled = { status: 'settled', settledAt: '2026-10-01T00:00:00Z', repoId: '7', claimSignature: 'sig', amountBaseUnits: '168000000' }
  const proof = { status: 'settled', signature: 'sig', amountBaseUnits: '168000000' }
  const latest = payoutShare(market, settled, proof)
  assert.deepEqual([latest.headline, latest.metric, latest.detail], ['Latest builder payout', '0.168 SOL', 'Builder fees paid to the verified payout wallet'])
  assert.equal(latest.caption, 'Latest builder payout for owner/repo on repo.ing: 0.168 SOL.\nSettled: 2026-10-01T00:00:00.000Z\n' +
    'Receipt: https://explorer.solana.com/tx/sig\nhttps://repo.ing/token/Mint7')
  assert.doesNotMatch(latest.caption, /earned|claimed|total/i)
  // A payout asked for by its signature (the claim page's card) is that payout, not necessarily the latest.
  assert.equal(payoutShare(market, settled, proof, { latest: false }).headline, 'Builder payout')
  const model = payoutShare(market, settled, proof, { model: true })
  assert.deepEqual([model.headline, model.detail], ['Latest payout to the model owner', 'Fees paid to the model owner’s verified payout wallet'])
  assert.match(model.caption, /^Latest payout to the model owner for owner\/repo on repo\.ing: 0\.168 SOL\./)
})

test('route: a market on its curve gets its graduation card by default and names both cards', async () => {
  const response = await card(CURVE)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.deepEqual([response.headers.get('x-repoing-share-kind'), response.headers.get('x-repoing-share-kinds')], ['graduation', 'graduation,payout'])
  assert.match(decodeURIComponent(response.headers.get('x-repoing-share-text')), /^New1Direction\/Waternot on repo\.ing\nGraduation progress: /)
  // Unknown card types are refused as before.
  assert.equal((await card(CURVE, '?kind=volume')).status, 400)
})

test('route: a graduated market offers only its payout card; without a payout it says so, with no retry', async () => {
  const graduation = await card(GRADUATED, '?kind=graduation')
  assert.equal(graduation.status, 409)
  assert.deepEqual(await graduation.json(), shareCardNotOffered({ migrated: true }, 'graduation'))
  for (const query of ['', '?kind=auto', '?kind=payout']) {
    const response = await card(GRADUATED, query)
    assert.equal(response.status, 404, query)
    const body = await response.json()
    assert.deepEqual(body, { error: 'No builder payout yet. This card shows the latest verified payout once a repository admin claims builder fees.',
      code: SHARE_CARD_ERRORS.NO_PAYOUT_YET, kinds: ['payout'] })
    assert.doesNotMatch(body.error, /retry/i)
  }
  // A payout named by its signature that is not settled yet (a claim just sent) is worth a retry.
  const named = await card(GRADUATED, `?signature=${bs58.encode(Buffer.alloc(64, 7))}`)
  assert.equal(named.status, 503)
  assert.deepEqual((await named.json()).kinds, ['payout'])
})

test('route: a stock pair gets no card, with the reason; a transient failure still asks for a retry', async () => {
  for (const query of ['', '?kind=graduation', '?kind=payout']) {
    const response = await card(STOCK, query)
    assert.equal(response.status, 409, query)
    assert.deepEqual(await response.json(), { code: SHARE_CARD_ERRORS.CARD_NOT_OFFERED, kinds: [],
      error: 'Share cards cover SOL markets only: this market\'s progress is in METAx, and a stock pair has no builder payout to show.' })
  }
  const stale = await card(STALE)
  assert.equal(stale.status, 503)
  const body = await stale.json()
  assert.match(body.error, /Please retry shortly\.$/)
  assert.equal(body.code, undefined)
  assert.deepEqual(body.kinds, ['graduation', 'payout'])
})

test('dialog: tabs only for the cards the route names, the latest payout labelled so, and no Retry on a final answer', async () => {
  const { MarketShareCard } = await appModule('app/components/market-share-card.jsx')
  // Before the route has answered, no tab is shown (none is known to work).
  const closed = html(h(MarketShareCard, { mint: CURVE.mint, open: false, onOpenChange() {} }))
  assert.doesNotMatch(closed, /share-card-tabs|Graduation progress/)
  assert.doesNotMatch(html(h(MarketShareCard, { mint: CURVE.mint, signature: 'sig' })), /share-card-tabs/)
  const source = readFileSync(new URL('../app/components/market-share-card.jsx', import.meta.url), 'utf8')
  assert.match(source, /const LABELS = \{ graduation: 'Graduation progress', payout: 'Latest builder payout' \}/)
  assert.match(source, /useState\(signature \? 'payout' : 'auto'\)/)
  assert.match(source, /\{!signature && kinds\?\.length > 1 && <div className="share-card-tabs"/)
  assert.match(source, /if \(!signature && Array\.isArray\(body\.kinds\)\) setKinds\(body\.kinds\)/)
  assert.match(source, /throw Object\.assign\(Error\(body\.error \|\| 'Card unavailable'\), \{ final: Boolean\(body\.code\) \}\)/)
  assert.match(source, /\{!error\.final && <button type="button" className="button outline" onClick=\{\(\) => setRetry\(v => v \+ 1\)\}>Retry<\/button>\}/)
})
