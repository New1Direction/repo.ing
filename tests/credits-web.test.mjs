import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { CREDITS_SESSION_SECONDS, assertPayment, buildPayment, creditsCall, creditsWebSettings, openCreditsSession, outcomeOf,
  parseQuote, parseSolanaPay, readLamports, sealCreditsSession, signInToCredits } from '../src/credits-web.mjs'

// The route imports next/server the way Next resolves it (tests/fixtures/jsx-hooks.mjs).
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))
const route = await import('../app/api/credits/convert/[repo]/route.js')

// "Claim as AI credits" (src/credits-web.mjs) without services: settings, the quote and payment checks, the session cookie,
// the server-to-server sign-in and the route's refusals. tests/credits-web-db.test.mjs runs the steps on PostgreSQL.
const TREASURY = Keypair.generate().publicKey.toBase58()
const REFERENCE = Keypair.generate().publicKey.toBase58()
const HANDOFF = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: 'a'.repeat(40) }
const ON = { ...HANDOFF, CREDITS_WEB_CONVERT_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing', CREDITS_TREASURY_ADDRESS: TREASURY }
const SETTINGS = { origin: 'https://credits.repo.ing', treasury: TREASURY, network: 'mainnet' }
const quoteFor = (extra = {}) => ({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', lamports: 250_000_000, credit_micro: 27_450_000, price_micro_per_sol: 109_800_000,
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), network: 'mainnet',
  solana_pay_url: `solana:${TREASURY}?amount=0.25&reference=${REFERENCE}&label=repo.ing%20AI%20credits&message=Quote`, ...extra })

test('dark unless switched on, with the handoff, an https credit service and a treasury; devnet never in production', () => {
  assert.equal(creditsWebSettings({}), null)
  assert.equal(creditsWebSettings({ ...ON, CREDITS_WEB_CONVERT_ENABLED: '1' }), null)
  assert.equal(creditsWebSettings({ ...ON, REPO_INFERENCE_HANDOFF_ENABLED: 'false' }), null, 'the sign-in handoff must be on')
  assert.deepEqual(creditsWebSettings(ON), SETTINGS)
  assert.equal(creditsWebSettings({ ...ON, REPO_INFERENCE_CREDITS_ORIGIN: 'http://credits.repo.ing' }), null)
  assert.equal(creditsWebSettings({ ...ON, REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing/v1' }), null)
  assert.equal(creditsWebSettings({ ...ON, CREDITS_TREASURY_ADDRESS: 'not-a-key' }), null)
  assert.equal(creditsWebSettings({ ...ON, CREDITS_WEB_NETWORK: 'devnet', NODE_ENV: 'production' }), null)
  assert.equal(creditsWebSettings({ ...ON, CREDITS_WEB_NETWORK: 'testnet' }), null)
  assert.equal(creditsWebSettings({ ...ON, CREDITS_WEB_NETWORK: 'devnet', REPO_INFERENCE_CREDITS_ORIGIN: 'http://127.0.0.1:8080' }).network, 'devnet')
  assert.equal(creditsWebSettings({ ...ON, NODE_ENV: 'production', REPO_INFERENCE_CREDITS_ORIGIN: 'http://127.0.0.1:8080' }), null)
})

test('amounts are 0.01 to 100 SOL, in whole lamports', () => {
  assert.equal(readLamports('10000000'), 10_000_000n)
  assert.equal(readLamports('100000000000'), 100_000_000_000n)
  for (const bad of ['9999999', '100000000001', '0', '-1', '1e9', ' 10000000', 10_000_000, null]) assert.throws(() => readLamports(bad), /SOL/)
})

test('a quote must pay the pinned treasury exactly what was asked, with one reference, on the expected network', () => {
  const parsed = parseQuote(quoteFor(), { settings: SETTINGS, lamports: 250_000_000n })
  assert.deepEqual([parsed.lamports, parsed.creditMicro, parsed.reference, parsed.network], ['250000000', '27450000', REFERENCE, 'mainnet'])
  const refused = (extra, lamports = 250_000_000n) => assert.throws(() => parseQuote(quoteFor(extra), { settings: SETTINGS, lamports }))
  refused({}, 300_000_000n)
  refused({ lamports: 250_000_001 })
  refused({ id: 'not-a-uuid' })
  refused({ credit_micro: 0 })
  refused({ expires_at: new Date(Date.now() - 1000).toISOString() })
  refused({ expires_at: new Date(Date.now() + 2 * 3600_000).toISOString() })
  refused({ network: 'devnet' })
  refused({ solana_pay_url: `solana:${Keypair.generate().publicKey.toBase58()}?amount=0.25&reference=${REFERENCE}` })
  refused({ solana_pay_url: `solana:${TREASURY}?amount=0.2500001&reference=${REFERENCE}` })
  refused({ solana_pay_url: `solana:${TREASURY}?amount=0.25&reference=${REFERENCE}&reference=${REFERENCE}` })
  refused({ solana_pay_url: `solana:${TREASURY}?amount=0.25&reference=${REFERENCE}&spl-token=${REFERENCE}` })
  refused({ solana_pay_url: `solana:${TREASURY}?amount=0.25&reference=${REFERENCE}&memo=x` })
  refused({ solana_pay_url: `solana:${TREASURY}?amount=0.25` })
  refused({ solana_pay_url: `https://evil.example/?amount=0.25&reference=${REFERENCE}` })
  assert.deepEqual(parseSolanaPay(`solana:${TREASURY}?amount=100&reference=${REFERENCE}`), { recipient: TREASURY, lamports: 100_000_000_000n, reference: REFERENCE })
})

test('the payment is one transfer to the treasury with the reference read-only; only those exact bytes, signed by the payer, pass', () => {
  const payer = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58()
  const prepared = buildPayment({ payer: payer.publicKey.toBase58(), treasury: TREASURY, lamports: '250000000', reference: REFERENCE, blockhash, lastValidBlockHeight: 100 })
  const unsigned = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
  assert.equal(unsigned.instructions.length, 1)
  const [transfer] = unsigned.instructions
  assert.ok(transfer.programId.equals(SystemProgram.programId))
  assert.deepEqual(transfer.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [[payer.publicKey.toBase58(), true, true], [TREASURY, false, true], [REFERENCE, false, false]])
  assert.equal(transfer.data.readBigUInt64LE(4), 250_000_000n)
  assert.ok(unsigned.feePayer.equals(payer.publicKey))

  const sign = (transaction, signer = payer) => { transaction.sign(signer); return transaction.serialize().toString('base64') }
  const ok = assertPayment(sign(unsigned), { message: prepared.message, payer: payer.publicKey.toBase58() })
  assert.equal(ok.signature.length > 80, true)

  const other = Keypair.generate()
  const changed = buildPayment({ payer: payer.publicKey.toBase58(), treasury: TREASURY, lamports: '250000001', reference: REFERENCE, blockhash, lastValidBlockHeight: 100 })
  assert.throws(() => assertPayment(sign(Transaction.from(Buffer.from(changed.transaction, 'base64'))), { message: prepared.message, payer: payer.publicKey.toBase58() }), /different payment/)
  const extra = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
  extra.add(new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(0) }))
  assert.throws(() => assertPayment(sign(extra), { message: prepared.message, payer: payer.publicKey.toBase58() }), /different payment/)
  const byOther = buildPayment({ payer: other.publicKey.toBase58(), treasury: TREASURY, lamports: '250000000', reference: REFERENCE, blockhash, lastValidBlockHeight: 100 })
  assert.throws(() => assertPayment(sign(Transaction.from(Buffer.from(byOther.transaction, 'base64')), other), { message: prepared.message, payer: payer.publicKey.toBase58() }), /different payment/)
  assert.throws(() => assertPayment(prepared.transaction, { message: prepared.message, payer: payer.publicKey.toBase58() }), /different payment/, 'unsigned')
  const forged = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
  forged.addSignature(payer.publicKey, Buffer.alloc(64, 7))
  assert.throws(() => assertPayment(forged.serialize({ verifySignatures: false }).toString('base64'), { message: prepared.message, payer: payer.publicKey.toBase58() }), /different payment/)
  assert.throws(() => assertPayment('%%%', { message: prepared.message, payer: payer.publicKey.toBase58() }), /Invalid signed payment/)
})

test('the credit service session is encrypted, bound to its GitHub account and short-lived', () => {
  const secret = randomBytes(32).toString('hex'), token = `ses_${'x'.repeat(40)}`, expiresAt = Date.now() + 10 * 60_000
  const sealed = sealCreditsSession({ token, githubUserId: '42', expiresAt }, secret)
  assert.ok(!sealed.includes(token) && !Buffer.from(sealed.split('.')[2], 'base64url').toString('utf8').includes('ses_'), 'the token is not readable in the cookie')
  assert.equal(openCreditsSession(sealed, '42', secret).token, token)
  assert.equal(openCreditsSession(sealed, '43', secret), null, 'another GitHub account')
  assert.equal(openCreditsSession(sealed, '42', randomBytes(32).toString('hex')), null, 'another key')
  assert.equal(openCreditsSession(`${sealed.slice(0, -2)}AA`, '42', secret), null, 'tampered')
  assert.equal(openCreditsSession(sealed, '42', secret, expiresAt + 1), null, 'expired')
  assert.equal(openCreditsSession(sealCreditsSession({ token, githubUserId: '42', expiresAt: Date.now() + (CREDITS_SESSION_SECONDS + 60) * 1000 }, secret), '42', secret), null, 'too long')
  assert.equal(openCreditsSession(sealCreditsSession({ token: 'short', githubUserId: '42', expiresAt }, secret), '42', secret), null)
})

test('repo.ing signs in for the builder with its own PKCE pair, server to server, and keeps only a well-formed token', async () => {
  const queries = [], calls = []
  const pool = { query: async (text, params) => { queries.push([text, params]); return { rows: [] } } }
  const fetchImpl = async (url, init) => {
    calls.push([url, init])
    return new Response(JSON.stringify({ token: `ses_${'y'.repeat(40)}`, login: 'octo', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 })
  }
  const session = await signInToCredits({ pool, settings: SETTINGS, repoId: '77', githubUserId: '42', login: 'octo', fetchImpl })
  assert.equal(session.token, `ses_${'y'.repeat(40)}`)
  assert.ok(session.expiresAt <= Date.now() + CREDITS_SESSION_SECONDS * 1000)
  const [url, init] = calls[0]
  assert.equal(url, 'https://credits.repo.ing/sessions')
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error')
  assert.ok(!Object.keys(init.headers).some(key => key.toLowerCase() === 'origin'), 'no Origin header: the credit service refuses browsers')
  const body = JSON.parse(init.body)
  const insert = queries.find(([text]) => /insert into auth_handoffs/.test(text))[1]
  assert.deepEqual([insert[2], insert[3], insert[4], insert[5]], ['repo-inference', '77', '42', 'octo'])
  assert.equal(insert[6], createHash('sha256').update(body.code_verifier).digest('base64url'), 'the stored challenge is the verifier sent')
  assert.equal(insert[1], createHash('sha256').update(body.code).digest('hex'), 'only the code hash is stored')

  const refusing = async () => new Response(JSON.stringify({ note: 'The sign-in was already used.' }), { status: 200 })
  await assert.rejects(signInToCredits({ pool, settings: SETTINGS, repoId: '77', githubUserId: '42', login: 'octo', fetchImpl: refusing }), /already used/)
})

test('credit service errors: its own words in one line, a 401 kept as 401, an outage as 503; outcomes', async () => {
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status })
  await assert.rejects(creditsCall(answer(409, { error: 'An open quote\nexists' }), 'https://credits.repo.ing', '/quotes'), error => error.message === 'An open quote exists' && error.status === 502)
  await assert.rejects(creditsCall(answer(401, {}), 'https://credits.repo.ing', '/quotes'), error => error.status === 401)
  await assert.rejects(creditsCall(async () => { throw new TypeError('fetch failed') }, 'https://credits.repo.ing', '/quotes'), error => error.status === 503)
  assert.deepEqual(outcomeOf({ status: 'credited', credit_micro: 5 }), { status: 'credited', creditedMicro: 5 })
  assert.deepEqual(outcomeOf({ status: 'awaiting_payment', review_pending: true }), { status: 'review' })
  assert.deepEqual(outcomeOf({ status: 'expired' }), { status: 'expired' })
  assert.equal(outcomeOf({ status: 'awaiting_payment' }), null)
  assert.equal(outcomeOf({ status: 'credited' }), null, 'credited without an amount is not believed')
})

test('the route: 404 while dark; then a session for this repository and the same origin', async t => {
  const keys = [...Object.keys(ON), 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN', 'DATABASE_URL']
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key] })
  process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex')
  process.env.APP_ORIGIN = 'https://repo.ing'
  // A pool that is never connected: every refusal below comes before a query.
  process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none'
  const session = repoId => encryptGithubSession({ repoId, permission: 'admin', githubUserId: '123', githubLogin: 'octo', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
  const make = (cookie, origin = 'https://repo.ing', body = { action: 'quote', lamports: '10000000' }) => ({ url: 'https://repo.ing/api/credits/convert/1',
    headers: new Headers({ origin }), cookies: { get: name => cookie && name.includes('github') ? { value: cookie } : undefined }, json: async () => body })
  const context = { params: Promise.resolve({ repo: '1' }) }
  for (const key of Object.keys(ON)) delete process.env[key]
  for (const method of ['GET', 'POST']) assert.equal((await route[method](make(session('1')), context)).status, 404)
  Object.assign(process.env, ON)
  for (const method of ['GET', 'POST']) for (const cookie of [undefined, session('2')]) {
    const response = await route[method](make(cookie), context)
    assert.equal(response.status, 403)
    assert.match(response.headers.get('cache-control'), /no-store/)
  }
  assert.equal((await route.POST(make(session('1'), 'https://evil.invalid'), context)).status, 403)
  assert.equal((await route.POST(make(session('1'), 'https://repo.ing', { action: 'quote', lamports: '10000000', treasury: TREASURY }), context)).status, 403)
  assert.equal((await route.POST(make(session('1'), 'https://repo.ing', { action: 'submit', id: 'x' }), context)).status, 400)
  assert.equal((await route.POST(make(session('1'), 'https://repo.ing', { action: 'drain', id: 1 }), context)).status, 400)
  assert.ok(new PublicKey(TREASURY))
})

test('migration 0065 is expand-only, appended last with the largest journal time, and declared in the schema', () => {
  const sql = readFileSync('drizzle/0065_credit_conversions.sql', 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "credit_conversions"/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "credit_conversions_one_open" ON "credit_conversions" \("github_user_id"\) WHERE "status" IN \('quoted', 'prepared', 'submitted'\)/)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP)\b|ALTER TABLE/i)
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const last = entries.at(-1)
  assert.equal(last.tag, '0065_credit_conversions')
  assert.ok(entries.slice(0, -1).every(entry => entry.when < last.when))
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  for (const name of ['credit_conversions', 'credit_conversions_status_check', 'credit_conversions_payment_check', 'credit_conversions_one_open']) assert.ok(schema.includes(`'${name}'`), name)
})
