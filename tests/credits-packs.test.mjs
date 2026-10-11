import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { Keypair } from '@solana/web3.js'
import { IDENTITY_SIGN_IN_PAGES, encryptGithubSession } from '../app/lib/auth.mjs'
import { creditsCall } from '../src/credits-web.mjs'
import { PACKS_MICRO, PACK_ODDS, creditsPacksSettings, offerOf, packOutcome, parsePackQuote, readPack } from '../src/credits-packs.mjs'

// The route imports next/server the way Next resolves it (tests/fixtures/jsx-hooks.mjs).
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))
const route = await import('../app/api/credits/packs/route.js')

// AI credit packs on repo.ing/credits (src/credits-packs.mjs) without services: settings, the pack quote and spin checks,
// the offer, and the route's refusals. tests/credits-packs-chain.test.mjs runs the steps on PostgreSQL and a validator.
const TREASURY = Keypair.generate().publicKey.toBase58()
const REFERENCE = Keypair.generate().publicKey.toBase58()
const HANDOFF = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: 'a'.repeat(40) }
const ON = { ...HANDOFF, CREDITS_WEB_PACKS_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing', CREDITS_TREASURY_ADDRESS: TREASURY }
const SETTINGS = { origin: 'https://credits.repo.ing', treasury: TREASURY, network: 'mainnet' }
// A $25 pack at $109.80 a SOL: ceil(25e6 x 1e9 / 109.8e6) = 227686704 lamports, the fewest worth the pack.
const LAMPORTS = 227_686_704
const quoteFor = (extra = {}) => ({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', kind: 'pack', pack_micro: 25_000_000, credit_micro: 25_000_000,
  lamports: LAMPORTS, price_micro_per_sol: 109_800_000, treasury: TREASURY, reference: REFERENCE, status: 'awaiting_payment', network: 'mainnet',
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  solana_pay_url: `solana:${TREASURY}?amount=0.227686704&reference=${REFERENCE}&label=repo.ing%20AI%20credits&message=Credit%20pack`, ...extra })

test('dark unless packs are switched on, with the handoff, an https credit service and a treasury', () => {
  assert.equal(creditsPacksSettings({}), null)
  assert.equal(creditsPacksSettings({ ...ON, CREDITS_WEB_PACKS_ENABLED: '1' }), null)
  assert.equal(creditsPacksSettings({ ...ON, REPO_INFERENCE_HANDOFF_ENABLED: 'false' }), null, 'the sign-in handoff must be on')
  assert.deepEqual(creditsPacksSettings(ON), SETTINGS)
  assert.deepEqual(creditsPacksSettings({ ...ON, CREDITS_WEB_CONVERT_ENABLED: 'false' }), SETTINGS, 'independent of the conversion switch')
  assert.equal(creditsPacksSettings({ ...ON, REPO_INFERENCE_CREDITS_ORIGIN: 'http://credits.repo.ing' }), null)
  assert.equal(creditsPacksSettings({ ...ON, CREDITS_TREASURY_ADDRESS: 'not-a-key' }), null)
  assert.equal(creditsPacksSettings({ ...ON, CREDITS_WEB_NETWORK: 'devnet', NODE_ENV: 'production' }), null)
})

test('a pack is $10, $25, $50 or $100, in micro-USD', () => {
  assert.deepEqual(PACKS_MICRO, [10_000_000, 25_000_000, 50_000_000, 100_000_000])
  for (const pack of PACKS_MICRO) assert.equal(readPack(String(pack)), pack)
  for (const bad of ['5000000', '25000001', '0', '25', '$25', 25_000_000, null, ' 25000000']) assert.throws(() => readPack(bad), /\$10, \$25, \$50 or \$100/)
})

test('a pack quote: this pack, the pinned treasury, the fewest lamports worth the pack, one reference, the expected network', () => {
  const parsed = parsePackQuote(quoteFor(), { settings: SETTINGS, packMicro: 25_000_000 })
  assert.deepEqual([parsed.lamports, parsed.priceMicroPerSol, parsed.reference, parsed.network], [String(LAMPORTS), '109800000', REFERENCE, 'mainnet'])
  const refused = (extra, packMicro = 25_000_000) => assert.throws(() => parsePackQuote(quoteFor(extra), { settings: SETTINGS, packMicro }), /Nothing was paid/)
  refused({}, 50_000_000)
  refused({ kind: 'conversion' })
  refused({ pack_micro: 50_000_000 })
  refused({ credit_micro: 24_000_000 })
  refused({ id: 'not-a-uuid' })
  refused({ expires_at: new Date(Date.now() - 1000).toISOString() })
  refused({ expires_at: new Date(Date.now() + 2 * 3600_000).toISOString() })
  refused({ network: 'devnet' })
  // One lamport more than the pack is worth, or one less: the credit ledger's own rule is checked here too.
  refused({ lamports: LAMPORTS + 1, solana_pay_url: `solana:${TREASURY}?amount=0.227686705&reference=${REFERENCE}` })
  refused({ lamports: LAMPORTS - 1, solana_pay_url: `solana:${TREASURY}?amount=0.227686703&reference=${REFERENCE}` })
  refused({ lamports: 5_000_000, price_micro_per_sol: 5_000_000_000, solana_pay_url: `solana:${TREASURY}?amount=0.005&reference=${REFERENCE}` })
  refused({ solana_pay_url: `solana:${Keypair.generate().publicKey.toBase58()}?amount=0.227686704&reference=${REFERENCE}` })
  refused({ solana_pay_url: `solana:${TREASURY}?amount=0.227686705&reference=${REFERENCE}` })
  refused({ treasury: Keypair.generate().publicKey.toBase58() })
  refused({ reference: Keypair.generate().publicKey.toBase58() })
  assert.throws(() => parsePackQuote(quoteFor({ solana_pay_url: `solana:${TREASURY}?amount=0.227686704&reference=${REFERENCE}&spl-token=${REFERENCE}` }),
    { settings: SETTINGS, packMicro: 25_000_000 }), /unexpected payment request/)
})

test('the outcome: credited only with a spin that matches the pack; anything else credited goes to a review', () => {
  const spin = (multiplier_bps, extra = {}) => ({ id: '6f1a1c86-9a52-4d1e-8f26-2b1b0a8e1c11', funding_receipt_id: 'x', paid_micro: 25_000_000,
    bonus_micro: 25_000_000 * (multiplier_bps - 10_000) / 10_000, multiplier_bps, plush: false, ...extra })
  assert.deepEqual(packOutcome({ status: 'credited', spin: spin(12_000) }, 25_000_000),
    { status: 'credited', spin: { id: '6f1a1c86-9a52-4d1e-8f26-2b1b0a8e1c11', multiplierBps: 12_000, bonusMicro: 5_000_000 } })
  assert.equal(packOutcome({ status: 'credited', spin: spin(10_000) }, 25_000_000).spin.bonusMicro, 0)
  for (const odd of [null, spin(15_000), spin(12_000, { paid_micro: 10_000_000 }), spin(12_000, { bonus_micro: 6_000_000 }), spin(12_000, { id: 'spin-1' })]) {
    assert.deepEqual(packOutcome({ status: 'credited', spin: odd }, 25_000_000), { status: 'review' })
  }
  assert.deepEqual(packOutcome({ status: 'awaiting_payment', review_pending: true }, 25_000_000), { status: 'review' })
  assert.deepEqual(packOutcome({ status: 'expired' }, 25_000_000), { status: 'expired' })
  assert.equal(packOutcome({ status: 'awaiting_payment' }, 25_000_000), null)
  assert.equal(packOutcome(null, 25_000_000), null)
})

test('the offer: sales, room left today and the odds, as the credit service states them; odd odds are not shown', () => {
  const policy = { outcomes: PACK_ODDS.map(o => ({ ...o })) }
  assert.deepEqual(PACK_ODDS.map(o => o.probability_bps), [9_715, 250, 30, 5])
  assert.deepEqual(offerOf({ sales: 'live', account_room_micro: 240_000_000, policy, terms: ['One spin per paid pack.'] }),
    { sales: 'live', roomMicro: 240_000_000, odds: PACK_ODDS, terms: ['One spin per paid pack.'] })
  assert.deepEqual(offerOf({ sales: 'sandbox', account_room_micro: -1, policy: { outcomes: [{ multiplier_bps: 50_000, probability_bps: 10_000 }, { multiplier_bps: 10_000, probability_bps: 1 }] } }),
    { sales: 'sandbox', roomMicro: 0, odds: null, terms: [] })
  assert.equal(offerOf({ sales: 'free-for-all' }).sales, 'off')
  assert.equal(offerOf(null).sales, 'off')
  assert.deepEqual(offerOf({ sales: 'live', account_room_micro: 1, terms: ['x'.repeat(600), 7, 'ok\u0007'] }).terms, ['ok'])
})

test('a refusal is a 4xx answer; a 5xx answer or none may come after the credit service acted', async () => {
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status })
  const outcome = fetchImpl => creditsCall(fetchImpl, 'https://credits.repo.ing', '/packs', { method: 'POST', body: {} }).then(() => null, error => [error.status, error.refused])
  assert.deepEqual(await outcome(answer(409, { error: 'An open pack quote exists.' })), [502, true])
  assert.deepEqual(await outcome(answer(401, { error: 'Sign in again.' })), [401, true])
  assert.deepEqual(await outcome(answer(503, { error: 'Credit pack sales are off' })), [502, false])
  assert.deepEqual(await outcome(answer(502, null)), [502, false])
  assert.deepEqual(await outcome(async () => { throw new TypeError('fetch failed') }), [503, false])
})

test('the route: 404 while dark; a GitHub session for the steps, and the same origin for POST', async t => {
  const keys = [...Object.keys(ON), 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN', 'DATABASE_URL']
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key] })
  process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex')
  process.env.APP_ORIGIN = 'https://repo.ing'
  // A pool that is never connected: every answer below comes before a query.
  process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none'
  const session = encryptGithubSession({ scope: 'builders', repoId: null, permission: 'identity', githubUserId: '123', githubLogin: 'octo', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
  const make = (cookie, origin = 'https://repo.ing', body = { action: 'quote', packMicro: '25000000' }) => ({ url: 'https://repo.ing/api/credits/packs',
    headers: new Headers({ origin }), cookies: { get: name => cookie && name.includes('github') ? { value: cookie } : undefined }, json: async () => body })
  for (const key of Object.keys(ON)) delete process.env[key]
  for (const method of ['GET', 'POST']) assert.equal((await route[method](make(session))).status, 404)
  Object.assign(process.env, ON)
  const signedOut = await route.GET(make(undefined))
  assert.equal(signedOut.status, 200)
  assert.deepEqual(await signedOut.json(), { enabled: true, network: 'mainnet', signedIn: false, odds: PACK_ODDS })
  assert.match(signedOut.headers.get('cache-control'), /no-store/)
  assert.equal((await route.POST(make(undefined))).status, 403)
  assert.equal((await route.POST(make(session, 'https://evil.invalid'))).status, 403)
  assert.equal((await route.POST(make(session, 'https://repo.ing', { action: 'quote', packMicro: '25000000', treasury: TREASURY }))).status, 403)
  assert.equal((await route.POST(make(session, 'https://repo.ing', { action: 'submit', id: 'x' }))).status, 400)
  assert.equal((await route.POST(make(session, 'https://repo.ing', { action: 'drain', id: 1 }))).status, 400)
})

test('"Sign in with GitHub" on /credits is an identity sign-in that returns to /credits', () => {
  assert.equal(IDENTITY_SIGN_IN_PAGES.credits, '/credits')
  for (const file of ['app/api/github/start/route.js', 'app/api/github/callback/route.js']) {
    assert.match(readFileSync(file, 'utf8'), /mode === 'credits' && !creditPacksAvailable\(\)/, `${file} refuses the mode while packs are dark`)
  }
})

test('migration 0066 is expand-only, after every earlier migration in the journal, and declared in the schema', () => {
  const sql = readFileSync('drizzle/0066_credit_pack_purchases.sql', 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "credit_pack_purchases"/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "credit_pack_purchases_one_open" ON "credit_pack_purchases" \("github_user_id"\) WHERE "status" IN \('requested', 'quoted', 'prepared', 'submitted'\)/)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP)\b|ALTER TABLE/i)
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const at = entries.findIndex(entry => entry.tag === '0066_credit_pack_purchases')
  assert.ok(at > 0 && entries.slice(0, at).every(entry => entry.when < entries[at].when))
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  for (const name of ['credit_pack_purchases', 'credit_pack_purchases_status_check', 'credit_pack_purchases_quote_check', 'credit_pack_purchases_payment_check',
    'credit_pack_purchases_spin_check', 'credit_pack_purchases_one_open']) assert.ok(schema.includes(`'${name}'`), name)
})

test('migration 0067 lets a handoff confirm only the GitHub account; appended after every earlier migration; old rows stay admin handoffs', () => {
  const sql = readFileSync('drizzle/0067_identity_handoffs.sql', 'utf8')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "permission" varchar\(16\) NOT NULL DEFAULT 'admin'/)
  assert.match(sql, /ALTER COLUMN "github_repo_id" DROP NOT NULL/)
  assert.match(sql, /CHECK \("permission" IN \('admin', 'identity'\) AND \("permission" = 'admin'\) = \("github_repo_id" IS NOT NULL\)\)/)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP TABLE|DROP COLUMN)\b/i)
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const index = entries.findIndex(entry => entry.tag === '0067_identity_handoffs')
  assert.ok(index > 0)
  assert.ok(entries.slice(0, index).every(entry => entry.when < entries[index].when))
  assert.ok(readFileSync('src/db/schema.mjs', 'utf8').includes("'auth_handoffs_permission_check'"))
})
