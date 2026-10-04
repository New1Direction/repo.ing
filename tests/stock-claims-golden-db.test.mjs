import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { register } from 'node:module'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import bs58 from 'bs58'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { POLICY_VERSION, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { reconcileJSON } from '../src/stock-reconcile.mjs'
import { STOCK_PAIR_NO_OWNER_CLAIM } from '../src/stock-owner-claims.mjs'
import { curveConfig, curvePool, key, stockMarket } from './fixtures/stock-chain.mjs'

// Golden: a SOL market's claim and fee-status outputs are exactly the same before and after a stock-paired market (with its
// stock ledgers, a collection, a launcher payout and a payout wallet bound by the same maintainer) is added to the database.
// Real PostgreSQL with every migration, the real SOL reconciler and claim path behind the real routes, and a JSON-RPC server
// that serves the SOL market's curve pool and config, the payout signer's balance and a blockhash, and refuses the claim's
// preflight simulation, so the claim runs to the last step before it would send anything. GitHub's API is stubbed.
const DB = 'repoing_stock_claims_golden_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const HELLO = '1296269', DOCS = '94911145', USER = '583231'
const config = key(), creator = Keypair.generate(), mint = key(), beneficiary = key()
const solPool = deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(mint), new PublicKey(config)).toBase58()
const docs = stockMarket({ repoId: DOCS })
const META_MINT = docs.quoteMint

// The chain, as JSON-RPC: the SOL curve pool holds exactly the unpaid builder fees (0.0994 SOL).
const accounts = new Map([[solPool, curvePool({ config, creator: creator.publicKey.toBase58(), baseMint: mint, creatorQuoteFee: 99_400_000n })],
  [config, curveConfig({ quoteMint: NATIVE_MINT.toBase58(), feeClaimer: key() })]])
const rpcCalls = []
const server = http.createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const call = JSON.parse(body), context = { slot: 100 }
  rpcCalls.push(call.method)
  const reply = result => response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
  if (call.method === 'getAccountInfo') {
    const account = accounts.get(call.params[0])
    return reply({ context, value: account ? { data: [account.data.toString('base64'), 'base64'], executable: false, lamports: 1_000_000,
      owner: account.owner.toBase58(), rentEpoch: 0, space: account.data.length } : null })
  }
  if (call.method === 'getBalance') return reply({ context, value: call.params[0] === creator.publicKey.toBase58() ? 1_000_000_000 : 0 })
  if (call.method === 'getLatestBlockhash') return reply({ context, value: { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 1000 } })
  if (call.method === 'simulateTransaction') return reply({ context, value: { err: { InstructionError: [3, { Custom: 6000 }] }, logs: ['Program log: refused by the test'],
    accounts: null, unitsConsumed: 0, returnData: null } })
  response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `This test RPC does not serve ${call.method}` } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

// GitHub, as the App verifier calls it: the maintainer, their administered repositories, and their permission on each.
const github = { repos: [[HELLO, 'octocat/Hello-World']], calls: [] }
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input?.url ?? input))
  if (url.hostname !== 'api.github.com') return realFetch(input, init)
  github.calls.push(url.pathname)
  if (url.pathname === '/user') return Response.json({ id: Number(USER), login: 'octocat' })
  if (url.pathname === '/user/repos') return Response.json(url.searchParams.get('page') === '1'
    ? github.repos.map(([id, fullName]) => ({ id: Number(id), full_name: fullName, private: false, archived: false, permissions: { admin: true } })) : [])
  if (url.pathname === `/repositories/${HELLO}`) return Response.json({ id: Number(HELLO), owner: { login: 'octocat' }, name: 'Hello-World', private: false, archived: false })
  if (url.pathname === '/repos/octocat/Hello-World/collaborators/octocat/permission') return Response.json({ permission: 'admin', user: { id: Number(USER) } })
  return new Response('not found', { status: 404 })
}

const saved = { ...process.env, pool: globalThis.__gitfunPool }
const KEYS = ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'PLATFORM_CREATOR_SECRET_KEY', 'APP_ORIGIN', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'BUILDER_REINVEST_ENABLED',
  'TIP_WALLET_ADDRESS', 'TIP_WALLET_SECRET_KEY', 'DBC_LEGACY_CONFIGS']
assert.equal(process.env.DATABASE_URL, URL_, 'a dedicated disposable database')
for (const name of KEYS.slice(1)) delete process.env[name]
Object.assign(process.env, { SOLANA_RPC_URL: `http://127.0.0.1:${server.address().port}`, DBC_CONFIG: config, APP_ORIGIN: 'https://repo.ing',
  PLATFORM_CREATOR_SECRET_KEY: JSON.stringify([...creator.secretKey]), GITHUB_APP_CLIENT_ID: 'Iv1.test-only', GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex') })
const admin = new pg.Pool({ connectionString: URL_.replace(`/${DB}`, '/postgres') })
await admin.query(`drop database if exists ${DB} with (force)`)
await admin.query(`create database ${DB}`)
const pool = new pg.Pool({ connectionString: URL_ })
globalThis.__gitfunPool = pool
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))
const { feeStatus, chain } = await import('../app/lib/server.mjs')
const { builderOverview } = await import('../app/lib/builders.mjs')
const { encryptGithubSession, githubSessionCookie, seal } = await import('../app/lib/auth.mjs')
const { createReconciler } = await import('../src/reconcile.mjs')
const { createBuilderReminders } = await import('../src/builder-reminders.mjs')
const claimRoute = await import('../app/api/claim/route.js')
const builderClaimRoute = await import('../app/api/builders/claim/route.js')
const previewRoute = await import('../app/api/claim/[repo]/preview/route.js')

test.after(async () => {
  globalThis.fetch = realFetch
  globalThis.__gitfunPool = saved.pool
  for (const name of KEYS) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] }
  await pool.end()
  await admin.query(`drop database if exists ${DB} with (force)`)
  await admin.end()
  await new Promise(resolve => server.close(resolve))
})

// The SOL market: 0.1988 SOL of builder fees, 0.0994 SOL already paid, its maintainer's payout wallet and a reminder subscription.
async function seedSol() {
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
  await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
    (${HELLO},'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,now())`)
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at) values ($1,'confirmed',$2,$3,'LauncherHello',$4,'Hello','HELLO','LaunchHello',
    'Hash',100,10,'finalized',now(),now())`, [HELLO, mint, solPool, creator.publicKey.toBase58()])
  await pool.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot) values
    ($1,$2,$3,'TradeA',0,99400000,$4,'dbc_creator_quote',11), ($1,$2,$3,'TradeB',0,99400000,$4,'dbc_creator_quote',12)`, [HELLO, mint, solPool, NATIVE_MINT.toBase58()])
  await pool.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at) values
    ($1,$2,99400000,$3,'ClaimHello','settled','2026-10-03T00:00:00Z')`, [HELLO, beneficiary, NATIVE_MINT.toBase58()])
  await pool.query(`insert into repo_beneficiaries(github_repo_id,github_user_id,wallet,bound_at) values ($1,$2,$3,'2026-10-02T00:00:00Z')`, [HELLO, USER, beneficiary])
  await pool.query(`insert into builder_reminders(github_user_id,email,revision,verified_at,next_check_at) values ($1,'maintainer@example.com',$2,now(),now())`, [USER, 'r'.repeat(32)])
}

// The stock-paired market, bound by the same maintainer, with the ledger rows its fees produce (none of them SOL).
async function seedStock() {
  github.repos.push([DOCS, 'facebook/docusaurus'])
  await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
    (${DOCS},'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,now())`)
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version)
    values ($1,'confirmed',$2,$3,$4,$5,'Docusaurus','DOCUSAURUS','LaunchDocs','Hash',100,12,'finalized',now(),now(),'meta-xstock',$6,1)`,
  [DOCS, docs.mint, docs.pool, docs.launcherWallet, creator.publicKey.toBase58(), META_MINT])
  const split = splitCurveFee({ creatorAmount: 99_400_000n, partnerAmount: 40_600_000n })
  await pool.query(`insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,launcher_amount,
    accumulator_amount,policy_version) values ($1,'meta-xstock',$2,$3,'StockTrade',0,20,99400000,40600000,$4,$5,$6)`,
  [DOCS, META_MINT, docs.pool, String(split.launcherAmount), String(split.accumulatorAmount), POLICY_VERSION])
  await pool.query(`insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,actual_amount,launcher_amount,accumulator_amount,
    terms_hash,status,signature,receipt,settled_at) values ($1,'meta-xstock',$2,'dbc_creator',99400000,99400000,$3,$4,repeat('e',64),'settled','StockCollect','{}',now())`,
  [DOCS, META_MINT, String(split.launcherAmount), String(99_400_000n - split.launcherAmount)])
  await pool.query(`insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status,signature,receipt,settled_at)
    values ($1,'meta-xstock',$2,$3,$4,'settled','StockPayout','{}',now())`, [DOCS, META_MINT, docs.launcherWallet, String(split.launcherAmount)])
  await pool.query(`insert into repo_beneficiaries(github_repo_id,github_user_id,wallet,bound_at) values ($1,$2,$3,'2026-10-02T00:00:00Z')`, [DOCS, USER, key()])
}

const builders = { scope: 'builders', repoId: null, permission: 'identity', githubUserId: USER, githubLogin: 'octocat', accessToken: 'ghu_test_only',
  sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 30 * 60_000 }
const claimSession = { repoId: HELLO, permission: 'admin', githubUserId: USER, githubLogin: 'octocat', accessToken: 'ghu_test_only',
  sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 30 * 60_000 }
const reviewFor = (session, repoId, purpose) => seal({ purpose, sessionId: session.sessionId, githubUserId: session.githubUserId, repoId, wallet: beneficiary,
  boundAt: new Date('2026-10-02T00:00:00Z').toISOString(), amount: '99400000', paid: '99400000', includeGraduatedFees: false, expiresAt: Date.now() + 10 * 60_000 })
const request = (path, { session, form, body }) => ({ url: `https://repo.ing${path}`, headers: new Headers({ origin: 'https://repo.ing' }),
  cookies: { get: name => name === githubSessionCookie ? { value: encryptGithubSession(session) } : undefined },
  formData: async () => { const data = new FormData(); for (const [k, v] of Object.entries(form ?? {})) data.set(k, v); return data },
  json: async () => body })
const FIXED_NOW = Date.parse('2026-10-04T12:00:00Z')
const quiet = async work => { const warn = console.warn; console.warn = () => {}; try { return await work() } finally { console.warn = warn } }

// Every SOL claim and fee-status output this market has, as JSON (amounts as text).
async function solOutputs() {
  const fees = await feeStatus(HELLO)
  const preview = await previewRoute.GET({ url: `https://repo.ing/api/claim/${HELLO}/preview` }, { params: Promise.resolve({ repo: HELLO }) })
  const overview = await builderOverview(builders)
  const row = overview.repositories.find(repository => repository.repoId === HELLO)
  const { expiresAt, review, ...stable } = row
  // The payout's priority-fee lookup falls back (this RPC serves no fee history) and says so on console.warn.
  const builderClaim = await quiet(async () => {
    const response = await builderClaimRoute.POST(request('/api/builders/claim', { session: builders, body: { review: reviewFor(builders, HELLO, 'builder-claim-review') } }))
    return { status: response.status, body: await response.json() }
  })
  const pageClaim = await quiet(async () => {
    const response = await claimRoute.POST(request('/api/claim', { session: claimSession, form: { repoId: HELLO, review: reviewFor(claimSession, HELLO, 'creator-claim-review') } }))
    return { status: response.status, destination: (await response.text()).match(/location\.replace\("([^"]+)"\)/)?.[1] }
  })
  await pool.query(`update builder_reminders set last_sent_at = null, next_check_at = now() - interval '1 second', baseline = '{}', delivery = null`)
  const sent = []
  const reminders = createBuilderReminders({ pool, secret: 's'.repeat(32), origin: 'https://repo.ing', now: () => FIXED_NOW,
    send: async message => { sent.push({ to: message.to, subject: message.subject, text: message.text }); return 'sent' },
    reconcile: createReconciler({ pool, connection: chain(), config }).reconcile })
  await pool.query(`update builder_reminders set next_check_at = $1`, [new Date(FIXED_NOW - 1000)])
  const reminderRun = await reminders.runOnce()
  const { rows: pending } = await pool.query("select count(*)::int as n from repo_claims where status = 'pending'")
  return JSON.parse(reconcileJSON({ fees, preview: { status: preview.status, body: await preview.json() },
    builderRow: { ...stable, reviewed: Boolean(review) }, payoutReady: overview.payoutReady,
    builderClaim, pageClaim,
    reminders: { run: reminderRun, sent }, pendingClaims: pending[0].n }))
}

test('SOL claim and fee-status outputs are unchanged with a stock-paired market present', { timeout: 120_000 }, async () => {
  await seedSol()
  const before = await solOutputs()
  // The baseline is the SOL path working end to end, up to the refused preflight.
  assert.equal(before.fees.status, 'MATCH')
  assert.deepEqual([before.fees.recordedEarned, before.fees.recordedClaimed, before.fees.onchainCreatorFee], ['198800000', '99400000', '99400000'])
  assert.deepEqual(before.preview, { status: 200, body: { available: '99400000' } })
  assert.deepEqual([before.builderRow.available, before.builderRow.reviewed, before.payoutReady], ['99400000', true, true])
  assert.deepEqual(before.builderClaim, { status: 409, body: { status: 'failed', error: 'Payout could not be confirmed. Refresh to check the current status.' } })
  assert.equal(before.pageClaim.destination, `https://repo.ing/claim/${HELLO}?error=claim-failed`)
  assert.deepEqual(before.reminders.run, { status: 'CHECKED', accepted: 1, failed: 0 })
  assert.match(before.reminders.sent[0].text, /octocat\/Hello-World: 0\.0994 SOL/)
  assert.equal(before.pendingClaims, 0, 'nothing was sent: the preflight refused it')
  assert.ok(rpcCalls.includes('simulateTransaction') && rpcCalls.includes('getLatestBlockhash'), 'the claim reached its preflight')

  await seedStock()
  const after = await solOutputs()
  assert.deepEqual(after, before, 'every SOL output is byte-for-byte the same')
})

test('the stock-paired market beside it gets no owner claim on any of those paths', async () => {
  const overview = await builderOverview(builders)
  const row = overview.repositories.find(repository => repository.repoId === DOCS)
  assert.deepEqual([row.available, row.review, row.feeStatus, row.ownerClaim.code], ['0', null, STOCK_PAIR_NO_OWNER_CLAIM, STOCK_PAIR_NO_OWNER_CLAIM])
  const preview = await previewRoute.GET({ url: `https://repo.ing/api/claim/${DOCS}/preview` }, { params: Promise.resolve({ repo: DOCS }) })
  assert.deepEqual([preview.status, (await preview.json()).code], [409, STOCK_PAIR_NO_OWNER_CLAIM])
  github.calls.length = 0
  const refused = await builderClaimRoute.POST(request('/api/builders/claim', { session: builders, body: { review: reviewFor(builders, DOCS, 'builder-claim-review') } }))
  assert.deepEqual([refused.status, (await refused.json()).code], [409, STOCK_PAIR_NO_OWNER_CLAIM])
  const page = await claimRoute.POST(request('/api/claim', { session: { ...claimSession, repoId: DOCS }, form: { repoId: DOCS } }))
  assert.equal(page.headers.get('location'), `https://repo.ing/claim/${DOCS}?error=${STOCK_PAIR_NO_OWNER_CLAIM}`)
  assert.deepEqual(github.calls, [], 'refused before any GitHub authority check')
  const { rows } = await pool.query(`select (select count(*) from repo_claims where github_repo_id = $1)::int as claims,
    (select count(*) from fee_events where github_repo_id = $1)::int as fees`, [DOCS])
  assert.deepEqual(rows[0], { claims: 0, fees: 0 }, 'nothing of the stock pair ever reached a SOL ledger')
})
