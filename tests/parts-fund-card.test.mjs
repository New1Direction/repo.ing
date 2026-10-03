import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import { appModule, h, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'

// The token page's parts slot (app/components/parts-fund.jsx) outside a Next request: cookies() reads the jar a test sets,
// the database is a fake pool serving one parts_funds row (or none), and every fetch is offline (token prices come back
// empty). Parts funds are on: a database and a tip wallet key.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'next/headers' || specifier === 'next/headers.js') return { url: 'repoing-test:next/headers', shortCircuit: true }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url !== 'repoing-test:next/headers') return next(url, context)
  return { format: 'module', shortCircuit: true, source: 'export const cookies = async () => { const jar = globalThis.__repoingTestCookies ?? {}; return { get: name => name in jar ? { name, value: jar[name] } : undefined } }' }
}`)}`)

const KEYS = ['DATABASE_URL', 'TIP_WALLET_SECRET_KEY', 'TIP_WALLET_ADDRESS', 'GITHUB_APP_CLIENT_SECRET', 'X_CLIENT_ID', 'X_CLIENT_SECRET']
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))
for (const key of KEYS) delete process.env[key]
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.TIP_WALLET_SECRET_KEY = bs58.encode(Keypair.generate().secretKey)
process.env.GITHUB_APP_CLIENT_SECRET = 'parts-fund-card-test-secret'

const DAY = 24 * 60 * 60_000
const REPO_ID = '4301'
let fundRow = null
globalThis.__gitfunPool = { query: async sql => {
  if (/from parts_funds where github_repo_id/.test(sql)) return { rows: fundRow ? [fundRow] : [] }
  if (/from parts_fund_items/.test(sql)) return { rows: [{ id: 'item-1', position: 0, name: 'MG996R servo', url: null, unitPriceCents: 1250, quantity: 4 }] }
  return { rows: [] }
} }
const net = offlineFetch()
test.after(() => {
  net.restore()
  delete globalThis.__gitfunPool
  delete globalThis.__repoingTestCookies
  for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
})

const { PartsFundBadge, PartsFundCard } = await appModule('app/components/parts-fund.jsx')
const { encryptGithubSession, githubSessionCookie } = await appModule('app/lib/auth.mjs')

const payout = Keypair.generate().publicKey.toBase58()
const market = (overrides = {}) => ({ repoId: REPO_ID, mint: Keypair.generate().publicKey.toBase58(), fullName: 'octo/robot-arm',
  beneficiaryWallet: payout, beneficiaryBoundAt: new Date(Date.now() - DAY).toISOString(), ...overrides })
// A GitHub admin's session, verified for one repository (the shape readGithubSession accepts).
const session = repoId => encryptGithubSession({ repoId, githubUserId: '77', githubLogin: 'octo', permission: 'admin', accessToken: 'ghu_test',
  sessionId: 'a1'.repeat(24), expiresAt: Date.now() + 30 * 60_000 })
const list = (overrides = {}) => ({ id: '6f1c2b8e-0d4a-4d55-9a57-2f5d0c3e9b10', repoId: REPO_ID, revision: 1, title: 'Robot arm v2', description: null,
  goalCents: 5000, deadline: new Date(Date.now() + 10 * DAY), status: 'open', closeReason: null, payoutWallet: null,
  createdAt: new Date(Date.now() - DAY), closedAt: null, settledAt: null, ...overrides })
async function slot(forMarket, cookie = null) {
  globalThis.__repoingTestCookies = cookie ? { [githubSessionCookie]: cookie } : {}
  return html(await resolveServer(h(PartsFundCard, { market: forMarket })), { wallet: true })
}
const ADD = 'Add a parts fund'

test('only a verified maintainer with a payout wallet gets "Add a parts fund"; visitors never see it', async () => {
  fundRow = null
  const visitor = await slot(market())
  assert.ok(!visitor.includes(ADD) && !visitor.includes('id="parts-fund"'), 'no list yet: a visitor sees nothing')
  assert.ok(!(await slot(market(), session('9999'))).includes(ADD), "another repository's maintainer is a visitor here")
  assert.ok(!(await slot(market({ beneficiaryWallet: null, beneficiaryBoundAt: null }), session(REPO_ID))).includes(ADD), 'no payout wallet to pay a funded list to')

  const builder = await slot(market(), session(REPO_ID))
  assert.ok(builder.includes(ADD) && builder.includes('Builder only'))
  assert.match(builder, /<section id="parts-fund" class="parts-addon"/)
  assert.ok(!builder.includes('parts-card'), 'a compact control, not the old always-open empty card')
  assert.match(builder, /<details class="parts-explainer"><summary>.*How parts funds work<\/summary>/, 'the explainer starts folded')
  assert.ok(builder.includes('$5,000') && builder.includes('7–60 days'))
})

test('once a list exists the card shows for everyone, with the explainer folded in and the hero badge while open', async () => {
  fundRow = list()
  const visitor = await slot(market())
  assert.ok(visitor.includes('Robot arm v2') && visitor.includes('How parts funds work'))
  assert.ok(!visitor.includes(ADD) && !visitor.includes('aria-label="Maintainer controls"'))
  const builder = await slot(market(), session(REPO_ID))
  assert.ok(builder.includes('Robot arm v2') && builder.includes('aria-label="Maintainer controls"'), 'the maintainer manages the list on the card')
  assert.ok(!builder.includes(ADD))
  assert.match(html(await resolveServer(h(PartsFundBadge, { market: market() }))), /href="#parts-fund"/)

  fundRow = list({ status: 'funded', closeReason: 'collected', closedAt: new Date(), settledAt: null })
  assert.equal(html(await resolveServer(h(PartsFundBadge, { market: market() }))), '', 'no badge once the list has closed')
})

test('after a settled missed list the maintainer can add a new one; backers see the missed list for two weeks', async () => {
  const missed = { status: 'failed', closeReason: 'deadline_missed', closedAt: new Date(Date.now() - 3 * DAY) }
  fundRow = list({ ...missed, settledAt: new Date(Date.now() - 2 * DAY) })
  const visitor = await slot(market())
  assert.ok(visitor.includes('Missed its goal · everyone refunded') && !visitor.includes(ADD))
  const builder = await slot(market(), session(REPO_ID))
  assert.ok(builder.includes(ADD) && !builder.includes('Robot arm v2'))

  fundRow = list({ ...missed, settledAt: new Date(Date.now() - 15 * DAY) })
  const staleVisitor = await slot(market())
  assert.ok(!staleVisitor.includes('Robot arm v2') && !staleVisitor.includes(ADD), 'stale: gone for visitors, and no add-on either')
  assert.ok((await slot(market(), session(REPO_ID))).includes(ADD))
})

test('the Parts tab is gone from the header and the phone menu, and /parts is a permanent redirect to Explore', async () => {
  const { AppHeader } = await appModule('app/components/ui.jsx')
  const header = html(h(AppHeader), { wallet: true })
  assert.ok(header.includes('href="/explore"') && header.includes('id="mobile-nav-panel"'))
  assert.ok(!header.includes('href="/parts"') && !header.includes('>Parts<'))
  const { GET } = await appModule('app/(site)/parts/route.js')
  assert.throws(() => GET(), error => /^NEXT_REDIRECT;\w+;\/explore;308;/.test(error.digest), 'a 308 to /explore, query dropped')
})
