import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { appModule, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'
import { graduationProgress } from '../src/graduation-state.mjs'
import { HF_DISCLAIMER, HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'

// HF_MARKETS_ENABLED gates on the handlers that serve a model market outside its token page: the link-preview card, the
// shared-return page and card, and the share card. Each runs with the flag off and on against the same model market (a
// fake read-only pool that records every query), so removing or moving a gate fails here. Nothing reaches the network.
const MODEL_ID = '4503599627370497'
const MINT = Keypair.generate().publicKey.toBase58(), POOL = Keypair.generate().publicKey.toBase58()
const ROW = { repoId: MODEL_ID, mint: MINT, pool: POOL, tokenName: 'gpt2', symbol: 'GPT2', indexedAt: new Date(), allocationVersion: null, discoveryVersion: null,
  launcherWallet: 'LauncherWallet', verificationBonusLamports: null, owner: 'openai-community', name: 'gpt2', fullName: 'openai-community/gpt2',
  description: 'Text generation · License: mit', avatarUrl: null, source: 'huggingface', stars: 0, forks: 0, updatedAt: null, githubCreatedAt: null,
  beneficiaryWallet: null, beneficiaryBoundAt: null, beneficiaryMethod: null, earned: '0', claimed: '0', volume24hLamports: '0', wasVerified: false,
  lastSqrtPrice: null, graduationStatus: null, observation: null, graduationError: null, migrationEvidenceHash: null }
// A fresh, verified curve observation for this market (src/market-share.mjs graduationShare checks every field).
const graduation = () => { const now = new Date().toISOString(); return { status: 'VERIFIED', reconciliation: JSON.stringify({ status: 'MATCH' }),
  migration_evidence_hash: null, observation: JSON.stringify({ ...graduationProgress('26754064634', '85000000000'), checkedAt: now, chainTime: now,
    repoId: MODEL_ID, mint: MINT, curve: POOL }) } }

const queries = []
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
globalThis.__gitfunPool = { query: async sql => {
  queries.push(sql)
  return { rows: /where m\.mint = \$1/.test(sql) ? [ROW] : /from graduation_observations o/.test(sql) ? [graduation()] : [] }
} }
const net = offlineFetch()
test.after(() => { net.restore(); delete globalThis.__gitfunPool; delete process.env.DATABASE_URL })

const withFlag = async (value, work) => {
  if (value === undefined) delete process.env.HF_MARKETS_ENABLED; else process.env.HF_MARKETS_ENABLED = value
  queries.length = 0
  try { return await work() } finally { delete process.env.HF_MARKETS_ENABLED }
}
const readsLogo = () => queries.some(sql => /select token_image from markets/.test(sql))

test('link-preview card: a model market gets the generic card without the flag, its own card (logo read) with it', async () => {
  const { GET } = await appModule('app/(site)/token/[mint]/opengraph-image/route.jsx')
  const call = () => GET(new Request(`https://repo.ing/token/${MINT}/opengraph-image`), { params: Promise.resolve({ mint: MINT }) })
  await withFlag(undefined, async () => {
    assert.equal((await call()).headers.get('content-type'), 'image/png')
    assert.equal(readsLogo(), false, 'stops at the gate')
  })
  await withFlag('true', async () => {
    assert.equal((await call()).headers.get('content-type'), 'image/png')
    assert.equal(readsLogo(), true, 'goes on to draw the model card')
  })
})

test('shared return: the page and its card exist only with the flag, and carry the disclaimer', async () => {
  const page = await appModule('app/(site)/token/[mint]/return/[pct]/page.jsx')
  const { GET } = await appModule('app/(site)/token/[mint]/return/[pct]/image/route.jsx')
  const params = () => Promise.resolve({ mint: MINT, pct: '12.5' })
  const image = () => GET(new Request(`https://repo.ing/token/${MINT}/return/12.5/image`), { params: params() })
  await withFlag(undefined, async () => {
    assert.deepEqual(await page.generateMetadata({ params: params() }), { title: 'repo.ing', robots: { index: false } })
    await assert.rejects(page.default({ params: params() }), error => String(error.digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404'))
    await image()
    assert.equal(readsLogo(), false)
  })
  await withFlag('true', async () => {
    const metadata = await page.generateMetadata({ params: params() })
    assert.ok(metadata.description.includes(HF_DISCLAIMER_SHORT), metadata.description)
    assert.ok(html(await page.default({ params: params() }), { wallet: true }).replaceAll('&#x27;', "'").includes(HF_DISCLAIMER))
    await image()
    assert.equal(readsLogo(), true)
  })
})

test('share card: not found without the flag; with it, the caption carries the disclaimer', async () => {
  const { GET } = await appModule('app/api/market/[mint]/share-card/route.js')
  const call = () => GET(new Request(`https://repo.ing/api/market/${MINT}/share-card?kind=graduation`), { params: Promise.resolve({ mint: MINT }) })
  await withFlag(undefined, async () => {
    const response = await call()
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Market not found' })
  })
  await withFlag('true', async () => {
    const response = await call()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    const caption = decodeURIComponent(response.headers.get('x-repoing-share-text'))
    assert.match(caption, /^openai-community\/gpt2 on repo\.ing\nGraduation progress: /)
    assert.ok(caption.endsWith(`\n${HF_DISCLAIMER_SHORT}`), caption)
  })
})

// Elements passed as props (the share menu) are found in the page's tree without rendering it.
function find(node, match) {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found } return null }
  if (!node || typeof node !== 'object' || !node.props) return null
  if (match(node)) return node
  for (const value of Object.values(node.props)) { const found = find(value, match); if (found) return found }
  return null
}

test('model token page: the share menu gets the disclaimer share text and no README badge', () => withFlag('true', async () => {
  const { ModelTokenPage } = await appModule('app/components/hf/model-token-page.jsx')
  const { ShareMarket } = await appModule('app/components/share-market.jsx')
  const tree = await resolveServer(await ModelTokenPage({ market: { ...ROW, priceSol: null, remaining: '0' } }))
  const share = find(tree, node => node.type === ShareMarket)
  assert.ok(share, 'the page renders the share menu')
  assert.equal(share.props.shareText, `openai-community/gpt2 on repo.ing. ${HF_DISCLAIMER_SHORT}`)
  assert.equal(share.props.readme, false)
}))
