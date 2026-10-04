import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { STOCK_PAIR_NO_OWNER_CLAIM, isStockPairMarket, noOwnerClaimMessage, stockPairOf, stockPairStamps, stockSymbol } from '../src/stock-owner-claims.mjs'
import { STOCK_POLICY_ERRORS } from '../src/stock-fee-policy.mjs'
import { createBuilderReminders } from '../src/builder-reminders.mjs'
import { walletStockPairs } from '../app/lib/stock-wallet.mjs'
// Registers tests/fixtures/jsx-hooks.mjs too: next/server resolves the way Next resolves it, and components render.
import { appModule, h, html } from './fixtures/render-jsx.mjs'

// Stock pairs have no owner claim of builder fees (STOCK_PAIR_NO_OWNER_CLAIM): both claim routes and the claim preview refuse
// one before any SOL claim code runs, while a SOL market goes exactly the way it went before. The routes run against a fake
// read-only pool, with no chain and no payout signer configured.
const SOL_ID = '1296269', STOCK_ID = '94911145', METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const STAMP = { quoteAssetId: 'meta-xstock', quoteMint: METAX }

// The read side of PostgreSQL as these paths see it: one SOL market and one stock-paired market.
const marketRow = (repoId, stamp) => ({ repoId, mint: `Mint${repoId}`, pool: `Pool${repoId}`, tokenName: 'Token', symbol: 'TOKEN', indexedAt: new Date(),
  allocationVersion: null, discoveryVersion: null, launcherWallet: 'LauncherWallet', verificationBonusLamports: null, quoteAssetId: stamp?.quoteAssetId ?? null,
  quoteMint: stamp?.quoteMint ?? null, owner: 'facebook', name: 'docusaurus', fullName: 'facebook/docusaurus', description: null, avatarUrl: null, source: 'github',
  stars: 1, forks: 0, updatedAt: null, githubCreatedAt: null, beneficiaryWallet: null, beneficiaryBoundAt: null, beneficiaryMethod: null, earned: '0',
  claimed: '0', volume24hLamports: '0', wasVerified: false, lastSqrtPrice: null, graduationStatus: null, observation: null, graduationError: null, migrationEvidenceHash: null })
const MARKETS = { [SOL_ID]: marketRow(SOL_ID, null), [STOCK_ID]: marketRow(STOCK_ID, STAMP) }
const queries = []
const pool = { async query(sql, params = []) {
  queries.push(sql)
  if (/select quote_asset_id as "quoteAssetId", quote_mint as "quoteMint" from markets/.test(sql)) {
    const row = MARKETS[params[0]]; return { rows: row ? [{ quoteAssetId: row.quoteAssetId, quoteMint: row.quoteMint }] : [] }
  }
  if (/github_repo_id = any\(\$1::bigint\[\]\) and \(quote_asset_id is not null/.test(sql)) {
    return { rows: params[0].filter(id => MARKETS[id]?.quoteAssetId).map(id => ({ repoId: id, ...STAMP })) }
  }
  if (/where m\.github_repo_id = \$1/.test(sql)) return { rows: MARKETS[params[0]] ? [MARKETS[params[0]]] : [] }
  if (/from repo_claims/.test(sql)) return { rows: [] }
  throw Error(`unexpected query: ${sql.slice(0, 90)}`)
} }

const saved = { ...process.env, pool: globalThis.__gitfunPool }
for (const key of ['PLATFORM_CREATOR_SECRET_KEY', 'DBC_CONFIG', 'SOLANA_RPC_URL', 'BUILDER_REINVEST_ENABLED']) delete process.env[key]
Object.assign(process.env, { DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', APP_ORIGIN: 'https://repo.ing',
  GITHUB_APP_CLIENT_ID: 'Iv1.test-only', GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex') })
globalThis.__gitfunPool = pool
test.after(() => {
  for (const key of ['DATABASE_URL', 'APP_ORIGIN', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  }
  globalThis.__gitfunPool = saved.pool
})
const { encryptGithubSession, githubSessionCookie, seal } = await import('../app/lib/auth.mjs')
const claimRoute = await import('../app/api/claim/route.js')
const builderClaimRoute = await import('../app/api/builders/claim/route.js')
const previewRoute = await import('../app/api/claim/[repo]/preview/route.js')

test('a stock pair is any market with a quote stamp; its refusal names the stock and where the fees go', () => {
  assert.equal(isStockPairMarket({ quoteAssetId: 'meta-xstock', quoteMint: METAX }), true)
  assert.equal(isStockPairMarket({ quote_asset_id: 'meta-xstock', quote_mint: METAX }), true)
  for (const sol of [{}, { quoteAssetId: null, quoteMint: null }, null, undefined]) assert.equal(isStockPairMarket(sol), false)
  assert.equal(stockSymbol(STAMP), 'METAx')
  assert.equal(stockSymbol({ quoteAssetId: 'unknown-asset' }), 'the stock')
  const message = noOwnerClaimMessage(STAMP)
  assert.match(message, /^Stock-paired markets have no owner claim\. 0\.30% of every trade goes to the wallet that launched the market, paid in METAx, and the builder share and repo\.ing's share become permanent \$REPOING \/ METAx liquidity\. Verifying the repository does not change this\.$/)
  assert.equal(STOCK_PAIR_NO_OWNER_CLAIM, STOCK_POLICY_ERRORS.STOCK_PAIR_NO_OWNER_CLAIM, 'one definition: the policy module\'s')
  assert.equal(STOCK_PAIR_NO_OWNER_CLAIM, 'STOCK_PAIR_NO_OWNER_CLAIM')
})

test('stamp reads: many repositories at once and one repository', async () => {
  assert.deepEqual([...await stockPairStamps(pool, [SOL_ID, STOCK_ID, STOCK_ID, 'bad', '0'])], [[STOCK_ID, STAMP]])
  assert.deepEqual(await stockPairStamps({ query: () => assert.fail('no ids, no query') }, ['x']), new Map())
  assert.deepEqual(await stockPairOf(pool, STOCK_ID), STAMP)
  assert.equal(await stockPairOf(pool, SOL_ID), null)
  assert.equal(await stockPairOf(pool, '404'), null, 'no market: the SOL claim path refuses it as before')
  assert.equal(await stockPairOf({ query: () => assert.fail('never queried') }, 'not-a-repo'), null)
  await assert.rejects(stockPairOf({ query: async () => { throw Error('database down') } }, STOCK_ID), /database down/, 'no claim proceeds on an unread stamp')
})

const sessionFor = extra => ({ githubUserId: '583231', githubLogin: 'octocat', accessToken: 'ghu_test_only', sessionId: randomBytes(24).toString('hex'),
  expiresAt: Date.now() + 60_000, ...extra })
const request = (path, { session, form, body }) => ({ url: `https://repo.ing${path}`, headers: new Headers({ origin: 'https://repo.ing' }),
  cookies: { get: name => name === githubSessionCookie && session ? { value: encryptGithubSession(session) } : undefined },
  formData: async () => { const data = new FormData(); for (const [k, v] of Object.entries(form ?? {})) data.set(k, v); return data },
  json: async () => body })
const review = (session, repoId, purpose) => seal({ purpose, sessionId: session.sessionId, githubUserId: session.githubUserId, repoId, wallet: 'PayoutWallet',
  boundAt: new Date('2026-10-01T00:00:00Z').toISOString(), amount: '1000', paid: '0', includeGraduatedFees: false, expiresAt: Date.now() + 60_000 })
const streamed = async response => (await response.text()).match(/location\.replace\("([^"]+)"\)/)?.[1]

test('POST /api/claim: a stock pair goes back to its claim page with the code, before a review is read; SOL claims as before', async () => {
  const stockSession = sessionFor({ repoId: STOCK_ID, permission: 'admin' })
  queries.length = 0
  const refused = await claimRoute.POST(request('/api/claim', { session: stockSession, form: { repoId: STOCK_ID } }))
  assert.equal(refused.status, 303)
  assert.equal(refused.headers.get('location'), `https://repo.ing/claim/${STOCK_ID}?error=${STOCK_PAIR_NO_OWNER_CLAIM}`)
  assert.equal(queries.length, 1, 'one stamp read, and nothing of the claim path')
  // A SOL market's claim runs the claim path: with no payout signer configured it ends where it always did.
  const solSession = sessionFor({ repoId: SOL_ID, permission: 'admin' })
  const sol = await claimRoute.POST(request('/api/claim', { session: solSession, form: { repoId: SOL_ID, review: review(solSession, SOL_ID, 'creator-claim-review') } }))
  assert.equal(sol.status, 200)
  assert.equal(await streamed(sol), `https://repo.ing/claim/${SOL_ID}?error=payout-unavailable`)
  // An invalid session or review is refused exactly as before.
  const expired = await claimRoute.POST(request('/api/claim', { form: { repoId: SOL_ID } }))
  assert.equal(expired.status, 303)
  assert.equal(expired.headers.get('location'), `https://repo.ing/claim/${SOL_ID}?error=verification-failed`)
})

test('POST /api/builders/claim: a review that names a stock pair is refused with the code; a SOL review reaches the claim', async () => {
  const builders = sessionFor({ scope: 'builders', repoId: null, permission: 'identity' })
  const refused = await builderClaimRoute.POST(request('/api/builders/claim', { session: builders, body: { review: review(builders, STOCK_ID, 'builder-claim-review') } }))
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { status: 'failed', code: STOCK_PAIR_NO_OWNER_CLAIM, error: noOwnerClaimMessage(STAMP) })
  const sol = await builderClaimRoute.POST(request('/api/builders/claim', { session: builders, body: { review: review(builders, SOL_ID, 'builder-claim-review') } }))
  assert.equal(sol.status, 409)
  assert.deepEqual(await sol.json(), { status: 'failed', error: 'Payouts are paused while network funds are replenished.' })
})

test('GET /api/claim/<repo>/preview: nothing is ever available to an owner of a stock pair; SOL reads its fee status as before', async () => {
  const refused = await previewRoute.GET({ url: `https://repo.ing/api/claim/${STOCK_ID}/preview` }, { params: Promise.resolve({ repo: STOCK_ID }) })
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { available: null, code: STOCK_PAIR_NO_OWNER_CLAIM, error: noOwnerClaimMessage(STAMP) })
  const sol = await previewRoute.GET({ url: `https://repo.ing/api/claim/${SOL_ID}/preview` }, { params: Promise.resolve({ repo: SOL_ID }) })
  assert.equal(sol.status, 200)
  assert.deepEqual(await sol.json(), { available: null }, 'unconfigured chain: UNAVAILABLE, as before')
})

test('builder reminders list SOL markets only: a stock pair never gets a "claim your fees" email', async () => {
  const seen = []
  const db = { async query(sql, params) {
    seen.push(sql)
    if (/^select \* from builder_reminders/.test(sql)) return { rows: [{ github_user_id: '583231', email: 'a@example.com', verified_at: new Date(0), next_check_at: new Date(0),
      last_sent_at: null, baseline: '{}', delivery: null, revision: 'r' }] }
    if (/from repo_beneficiaries b join markets m/.test(sql)) return { rows: [] }
    if (/select github_user_id from builder_reminders/.test(sql)) return { rows: [{ github_user_id: '583231' }] }
    return { rows: [] }
  } }
  const reminders = createBuilderReminders({ pool: { query: db.query, connect: async () => ({ query: db.query, release() {} }) },
    send: async () => assert.fail('nothing to send'), reconcile: async () => assert.fail('no market listed'), secret: 's'.repeat(32), origin: 'https://repo.ing' })
  await reminders.runOnce()
  const list = seen.find(sql => /from repo_beneficiaries b join markets m/.test(sql))
  assert.match(list, /and m\.indexed_at is not null and m\.quote_asset_id is null limit 100/)
})

test('/wallet: a SOL wallet gets its rows back untouched and no stock field; stock-pair rows lose the builder claim', async () => {
  const sol = [{ repoId: SOL_ID, mint: 'MintSol', launchedByYou: true, builderWallet: true, builderAvailable: '5', discovery: null },
    { repoId: '42', mint: 'MintHeld', launchedByYou: false, builderWallet: false, builderAvailable: null, discovery: null }]
  const neverRead = async () => assert.fail('a SOL wallet never reads stock earnings')
  const solOnly = await walletStockPairs(pool, () => assert.fail('no connection for a SOL wallet'), 'W', sol, { earnings: neverRead })
  assert.equal(solOnly.rows, sol, 'the very same rows')
  assert.deepEqual(solOnly.fields, {}, 'no stockLauncher key at all')
  const held = await walletStockPairs({ query: () => assert.fail('no candidate, no query') }, () => null, 'W', [sol[1]], { earnings: neverRead })
  assert.deepEqual(held, { rows: [sol[1]], fields: {} })

  const stock = { repoId: STOCK_ID, mint: 'MintStock', launchedByYou: true, builderWallet: true, builderAvailable: '0', discovery: null }
  const view = { repoId: STOCK_ID, asset: { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8 }, multiplier: '1',
    raw: { earned: '10', collected: '4', paid: '1', pending: '0', payable: '3', uncollected: '6' }, shown: { earned: '10', collected: '4', paid: '1', pending: '0', payable: '3', uncollected: '6' } }
  const read = []
  const mixed = await walletStockPairs(pool, () => 'connection', 'W', [sol[0], stock], { earnings: async (db, connection, wallet) => { read.push([connection, wallet]); return [view] } })
  assert.deepEqual(read, [['connection', 'W']])
  assert.equal(mixed.rows[0], sol[0], 'the SOL row is the same object')
  assert.deepEqual(mixed.rows[1], { ...stock, stockPair: true, stockLauncher: view, builderWallet: false, builderAvailable: null })
  assert.deepEqual(mixed.fields.stockLauncher.totals.map(total => [total.asset.symbol, total.raw.payable]), [['METAx', '3']])
  const unread = await walletStockPairs(pool, () => 'connection', 'W', [stock], { earnings: async () => { throw Error('relation "stock_launcher_payouts" does not exist') } })
  assert.deepEqual([unread.fields, unread.rows[0].stockPair, unread.rows[0].builderWallet], [{ stockLauncher: null }, true, false],
    'a stock launcher whose earnings cannot be read is told so; nobody else is')
  const builderOnly = await walletStockPairs(pool, () => assert.fail('no launch, no earnings read'), 'W', [{ ...stock, launchedByYou: false }], { earnings: neverRead })
  assert.deepEqual([builderOnly.fields, builderOnly.rows[0].builderWallet], [{}, false])
  const down = await walletStockPairs({ query: async () => { throw Error('down') } }, () => null, 'W', [sol[0], stock], { earnings: neverRead })
  assert.deepEqual(down, { rows: [sol[0], stock], fields: {} }, 'stamps unreadable: rows as they came (the claim page still refuses a stock pair)')
})

test('the stock launcher tile renders nothing for a wallet without stock launches', async () => {
  const { StockLauncherTile } = await appModule('app/components/stock-launcher-wallet.jsx')
  assert.equal(html(h(StockLauncherTile, {})), '', 'no stockLauncher field: nothing at all')
  assert.match(html(h(StockLauncherTile, { stockLauncher: null })), /Launcher earnings in stocks.*Temporarily unavailable/)
})
