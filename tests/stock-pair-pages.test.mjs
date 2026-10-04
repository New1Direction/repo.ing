import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { appModule, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'

// The claim page and the token page of a stock-paired market (no owner claim, STOCK_PAIR_NO_OWNER_CLAIM): the claim page is
// the early return that explains where the fees go and runs no fee check, and the token page shows "Fee routing" in place of
// the builder claim link and the owner invitation, with amounts in METAx as wallets show it. A SOL market renders as before.
// Rendered outside a Next request against a fake read-only pool; the only chain read served is the METAx mint (its
// ScaledUiAmount multiplier), and every other request fails as an offline network would.
register(`data:text/javascript,${encodeURIComponent(`
const STUBS = {
  'next/headers': 'export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false }); export const headers = async () => new Headers()',
  'next/server': 'export const after = task => { (globalThis.__repoingTestAfter ??= []).push(task) }',
}
export async function resolve(specifier, context, next) {
  const name = specifier.replace(/\\.js$/, '')
  if (STUBS[name]) return { url: 'repoing-test:' + name, shortCircuit: true }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (!url.startsWith('repoing-test:')) return next(url, context)
  return { format: 'module', shortCircuit: true, source: STUBS[url.slice('repoing-test:'.length)] }
}`)}`)

const METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const METAX_MINT = JSON.parse(readFileSync(new URL('./fixtures/metax-mint.json', import.meta.url), 'utf8'))
const LAUNCHER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const STOCK_ID = '94911145', SOL_ID = '1296269'
const row = (repoId, mint, stamp) => ({ repoId, mint, pool: `Pool${repoId}`, tokenName: 'Docusaurus', symbol: 'DOCUSAURUS', indexedAt: new Date('2026-10-01T00:00:00Z'),
  allocationVersion: null, discoveryVersion: null, launcherWallet: LAUNCHER, verificationBonusLamports: null, quoteAssetId: stamp ? 'meta-xstock' : null,
  quoteMint: stamp ? METAX : null, owner: 'facebook', name: 'docusaurus', fullName: 'facebook/docusaurus', description: 'Easy to maintain open source documentation websites.',
  avatarUrl: null, source: 'github', stars: 60000, forks: 9000, updatedAt: null, githubCreatedAt: null, beneficiaryWallet: null, beneficiaryBoundAt: null,
  beneficiaryMethod: null, earned: '0', claimed: '0', volume24hLamports: '0', wasVerified: false, lastSqrtPrice: null, graduationStatus: null, observation: null,
  graduationError: null, migrationEvidenceHash: null })
const MARKETS = [row(STOCK_ID, 'MintStockDocs', true), row(SOL_ID, 'MintSolHello', false)]
// The stock ledgers' sums for the stock market: 0.003 METAx to the launcher, 0.011 METAx to the accumulator (raw).
const LEDGER = { repoId: STOCK_ID, mint: 'MintStockDocs', symbol: 'DOCUSAURUS', launcherWallet: LAUNCHER, assetId: 'meta-xstock', quoteMint: METAX,
  curveEarned: '300000', curveAccumulated: '1100000', graduatedEarned: '0', graduatedAccumulated: '0', collected: '0', paid: '0', pending: '0' }

const saved = { ...process.env }
const KEYS = ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'PLATFORM_CREATOR_SECRET_KEY', 'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_INSTALLATION_ID', 'HF_MARKETS_ENABLED', 'TIPS_ENABLED']
for (const key of KEYS) delete process.env[key]
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:18999'
const feeStatusReads = []
globalThis.__gitfunPool = { query: async (sql, params = []) => {
  if (/as "curveEarned"/.test(sql)) return { rows: params[0] === STOCK_ID ? [LEDGER] : [] }
  if (/from builder_fee_credits where github_repo_id=\$1/.test(sql)) { feeStatusReads.push(params[0]); return { rows: [] } }
  if (/where m\.mint = \$1/.test(sql)) return { rows: MARKETS.filter(market => market.mint === params[0]) }
  if (/where m\.github_repo_id = \$1/.test(sql)) return { rows: MARKETS.filter(market => market.repoId === params[0]) }
  return { rows: [] }
} }
// The METAx mint is the one account the chain serves; everything else on the network is offline.
const rpc = async (url, init) => {
  const { id, method, params } = JSON.parse(init.body)
  const value = method === 'getAccountInfo' && params[0] === METAX
    ? { data: [METAX_MINT.data, 'base64'], executable: false, lamports: 1, owner: METAX_MINT.owner, rentEpoch: 0, space: Buffer.from(METAX_MINT.data, 'base64').length } : null
  return Response.json({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } })
}
const net = offlineFetch([[/^http:\/\/127\.0\.0\.1:18999/, rpc]])
test.after(() => {
  net.restore()
  delete globalThis.__gitfunPool
  for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
})

const claimPage = await appModule('app/(site)/claim/[repo]/page.jsx')
const tokenPage = await appModule('app/(site)/token/[mint]/page.jsx')
const { StockPairClaimPage } = await appModule('app/components/stock-pair-claim.jsx')
const { clearQuoteAssetInfoCache } = await import('../src/quote-asset-info.mjs')
const decoded = markup => markup.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')
const askedGithub = () => net.requested.filter(url => /(^|\.)github\.com$/.test(new URL(url).hostname))
const MESSAGE = "Stock-paired markets have no owner claim. 0.30% of every trade goes to the wallet that launched the market, paid in METAx, and the builder share and repo.ing's share become permanent $REPOING / METAx liquidity. Verifying the repository does not change this."

test('/claim/<id> of a stock pair: the no-owner-claim page, no fee check and no GitHub request', async () => {
  clearQuoteAssetInfoCache(); net.requested.length = 0; feeStatusReads.length = 0
  const element = await claimPage.default({ params: Promise.resolve({ repo: STOCK_ID }), searchParams: Promise.resolve({}) })
  assert.equal(element.type, StockPairClaimPage, 'the early return, before the builder claim content')
  const markup = decoded(html(await resolveServer(StockPairClaimPage(element.props)), { wallet: true }))
  assert.ok(markup.includes('No owner claim on stock pairs') && markup.includes(MESSAGE))
  assert.match(markup, /data-code="STOCK_PAIR_NO_OWNER_CLAIM"/)
  assert.match(markup, /role="status"/)
  assert.ok(markup.includes('0.30%') && markup.includes('1.10%') && markup.includes('7xKX…gAsU'), 'the fee routing with the launcher')
  assert.ok(markup.includes('0.003 METAx earned so far') && markup.includes('0.011 METAx so far'), 'amounts as wallets show METAx')
  assert.doesNotMatch(markup, /Claim builder fees|Verify your GitHub|Available to claim|Invite repository owner/)
  assert.deepEqual(feeStatusReads, [], 'the SOL reconciler is never asked')
  assert.deepEqual(askedGithub(), [])
  const refused = decoded(html(await resolveServer(StockPairClaimPage({ ...element.props, query: { error: 'STOCK_PAIR_NO_OWNER_CLAIM' } })), { wallet: true }))
  assert.match(refused, /role="alert"[^>]*>.*That claim was not sent\./)
})

function find(node, match) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const item of node) { const found = find(item, match); if (found) return found } return null }
  if (match(node)) return node
  return find(node.props?.children, match)
}

test('/claim/<id> of a SOL market still gets the builder claim page', async () => {
  const element = await claimPage.default({ params: Promise.resolve({ repo: SOL_ID }), searchParams: Promise.resolve({}) })
  assert.notEqual(element.type, StockPairClaimPage)
  assert.ok(find(element, node => node.type?.name === 'ClaimContent'), 'the builder claim content, with its fee check')
  assert.ok(find(element, node => node.type === 'h1' && node.props.children === 'Claim builder fees'))
})

test('the token page of a stock pair shows its fee routing instead of the claim link and the owner invitation', async () => {
  clearQuoteAssetInfoCache(); feeStatusReads.length = 0
  const markup = decoded(html(await resolveServer(await tokenPage.default({ params: Promise.resolve({ mint: 'MintStockDocs' }), searchParams: Promise.resolve({}) })), { wallet: true }))
  assert.ok(markup.includes('Toward $REPOING / METAx liquidity'), 'the hero headline')
  assert.ok(markup.includes('0.011 METAx') && markup.includes('0.003 METAx to the launcher'))
  assert.match(markup, /id="fee-routing"/)
  assert.ok(markup.includes('Fee routing') && markup.includes('To the launcher, forever') && markup.includes('permanent $REPOING / METAx liquidity'))
  assert.ok(markup.includes('Stock pair: no owner claim'), 'the trust panel row')
  assert.doesNotMatch(markup, /Claim builder fees|Invite repository owner|Maintainer\? Verify here|Total repository earnings/)
  assert.deepEqual(feeStatusReads, [], 'no SOL fee status for a stock pair')
})

test('control: the token page of a SOL market keeps its claim link, invitation and earnings', async () => {
  const markup = decoded(html(await resolveServer(await tokenPage.default({ params: Promise.resolve({ mint: 'MintSolHello' }), searchParams: Promise.resolve({}) })), { wallet: true }))
  assert.ok(markup.includes('Claim builder fees') && markup.includes('Total repository earnings') && markup.includes('Maintainer? '))
  assert.doesNotMatch(markup, /Fee routing|no owner claim/)
})
