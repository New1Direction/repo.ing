import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { BUNDLE_VAULT_PROGRAM_ID, STATUS, backerAddress, bundleAddress, claimBackerFeesInstruction, createBundleInstruction, decodeBundle,
  depositInstruction, refundInstruction, tokenAccountOf } from '../src/bundle-vault.mjs'
import { BUNDLE_DEFAULTS, BUNDLE_RAISE, bundleFormSettings } from '../src/bundle-launch.mjs'
import { RAISE_REFUSALS, acceptSignedAction, acceptSignedCreate, bundleIdFrom, bundleReviewKey, openBundleReview, raiseTerms, simulationFailure,
  tokenFields } from '../src/bundle-raise.mjs'
import { createBackerCounter } from '../src/bundle-raise-chain.mjs'
import { DecisionError, OPT_OUT_ERROR } from '../src/maintainer-opt-outs.mjs'
import { LineageError } from '../src/repo-lineage.mjs'
import { createBundleApi } from '../app/lib/bundle-api.mjs'
import { walletBundleFields } from '../app/lib/bundle-wallet.mjs'
import { PHASE_LABELS, raisePhase, raisedPercent, timeLeft } from '../app/lib/bundle-view.mjs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { backerData, bundleData, fakeChain, fakePool } from './fixtures/bundle-raise-fakes.mjs'

// The Bundle raise flow (docs/BUNDLE_LAUNCH.md, PR C): the site's raise terms, the API's refusals and the exact transactions it
// builds, signs and relays, and the dark switch on every route and page. In-memory chain and database (tests/fixtures/
// bundle-raise-fakes.mjs): no validator, no PostgreSQL. The program side is tests/bundle-vault-chain.test.mjs.

const SOL = 1_000_000_000n
const REPO = '94911145'
const admin = Keypair.generate(), creator = Keypair.generate(), backer = Keypair.generate()
const NOW = Date.parse('2026-10-06T12:00:00Z')
const quiet = t => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'warn', () => {}) }

function harness({ hasMarket = false, overrides = {} } = {}) {
  const pool = fakePool({ hasMarket }), chain = fakeChain()
  const api = createBundleApi({ launchable: () => true, pool: () => pool, connection: () => chain, admin: () => admin,
    resolveRepository: async id => ({ githubRepoId: BigInt(id), fullName: 'octo/widget' }), launchAllowed: async () => {}, persistRepository: async () => {},
    lineage: async () => {}, validateImage: async value => { if (!value) throw Error('Choose a token image before reviewing the launch.'); return value },
    limit: () => null, now: () => NOW, broadcast: { intervalMs: 0, sleep: async () => {} }, ...overrides })
  return { pool, chain, api }
}
const post = (path, body) => new Request(`https://repo.ing${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = path => new Request(`https://repo.ing${path}`)
const call = async promise => { const response = await promise; return { status: response.status, body: await response.json() } }
const openBody = (fields = {}) => ({ action: 'prepare', repoId: REPO, tokenName: 'Widget', tokenSymbol: 'WDGT', tokenImage: 'data:image/png;base64,AAAA',
  launcherWallet: creator.publicKey.toBase58(), targetLamports: String(5n * SOL), deadlineDays: 3, ...fields })
const transactionOf = base64 => Transaction.from(Buffer.from(base64, 'base64'))
const sameInstruction = (actual, expected) => {
  assert.equal(actual.programId.toBase58(), expected.programId.toBase58())
  assert.deepEqual(actual.keys.map(k => k.pubkey.toBase58()), expected.keys.map(k => k.pubkey.toBase58()))
  assert.deepEqual(Buffer.from(actual.data), Buffer.from(expected.data))
}

test('the site\'s raise terms: 1 to 10 SOL (5 by default), deposits from 0.05 SOL, a deadline of 1, 3 or 7 days (3 by default)', () => {
  assert.deepEqual([BUNDLE_RAISE.minTargetLamports, BUNDLE_RAISE.maxTargetLamports, BUNDLE_RAISE.defaultTargetLamports, BUNDLE_RAISE.minDepositLamports],
    [SOL, 10n * SOL, 5n * SOL, 50_000_000n])
  assert.deepEqual([[...BUNDLE_RAISE.deadlineDays], BUNDLE_RAISE.defaultDeadlineDays], [[1, 3, 7], 3])
  assert.deepEqual(bundleFormSettings(), { minTargetLamports: '1000000000', maxTargetLamports: '10000000000', defaultTargetLamports: '5000000000',
    minDepositLamports: '50000000', deadlineDays: [1, 3, 7], defaultDeadlineDays: 3, opsPercent: '5%', backerPercent: '80%' })
  const terms = raiseTerms({ targetLamports: String(SOL), deadlineDays: '7' }, NOW)
  assert.deepEqual(terms, { targetLamports: SOL, minDepositLamports: 50_000_000n, deadline: NOW / 1000 + 7 * 86_400 })
  assert.equal(raiseTerms({ targetLamports: String(10n * SOL), deadlineDays: 1 }, NOW).targetLamports, 10n * SOL)
  for (const targetLamports of [String(SOL - 1n), String(10n * SOL + 1n), '5.5', '-1', '', undefined, 5.5, '0x10']) {
    assert.throws(() => raiseTerms({ targetLamports, deadlineDays: 3 }, NOW), { message: RAISE_REFUSALS.target }, String(targetLamports))
  }
  for (const deadlineDays of [0, 2, 30, '3x', '', undefined, 3.5]) {
    assert.throws(() => raiseTerms({ targetLamports: String(SOL), deadlineDays }, NOW), { message: RAISE_REFUSALS.deadline }, String(deadlineDays))
  }
  assert.deepEqual(tokenFields({ tokenName: 'W'.repeat(32), tokenSymbol: 'W'.repeat(10) }), { tokenName: 'W'.repeat(32), tokenSymbol: 'W'.repeat(10) })
  for (const fields of [{ tokenName: '', tokenSymbol: 'W' }, { tokenName: 'W'.repeat(33), tokenSymbol: 'W' }, { tokenName: 'W', tokenSymbol: 'W'.repeat(11) },
    { tokenName: 'W', tokenSymbol: 7 }, { tokenName: ['W'], tokenSymbol: 'W' }]) assert.throws(() => tokenFields(fields), { message: RAISE_REFUSALS.token })
})

test('dark: the routes that start or fund a raise answer 404 while Bundle launches are off', async () => {
  const saved = process.env.BUNDLE_LAUNCHES_ENABLED
  try {
    for (const flag of [undefined, 'false', 'true']) {
      if (flag === undefined) delete process.env.BUNDLE_LAUNCHES_ENABLED; else process.env.BUNDLE_LAUNCHES_ENABLED = flag
      const { POST: open } = await import('../app/api/bundles/route.js')
      const item = await import('../app/api/bundles/[id]/route.js')
      const params = { params: Promise.resolve({ id: '1' }) }
      for (const response of [await open(post('/api/bundles', openBody())), await open(post('/api/bundles', { action: 'submit', bundleId: '1' })),
        await item.POST(post('/api/bundles/1', { action: 'deposit', wallet: backer.publicKey.toBase58(), lamports: '50000000' }), params)]) {
        assert.equal(response.status, 404, String(flag))
        assert.deepEqual(await response.json(), { error: 'Not found' })
      }
    }
  } finally { if (saved === undefined) delete process.env.BUNDLE_LAUNCHES_ENABLED; else process.env.BUNDLE_LAUNCHES_ENABLED = saved }
})

test('dark: the launch form\'s option follows the switch; existing bundles are shown whatever it says', () => {
  const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const launchPage = source('app/(site)/launch/[repo]/page.jsx'), raisePage = source('app/(site)/bundle/[id]/page.jsx')
  assert.match(launchPage, /const bundle = bundleLaunchable\(\) \? bundleFormSettings\(\) : null/)
  assert.match(launchPage, /const liveBundleId = pool \?/, 'a live bundle is shown whatever the switch says')
  // A standard launch beside a live bundle is refused by the launch coordinator, under the repository lock, whatever the switch.
  assert.doesNotMatch(source('app/api/launch/route.js'), /bundle/i)
  // The raise page and the token page's vault tab never hide an existing bundle; the page only stops taking deposits.
  assert.doesNotMatch(raisePage, /if \(!bundleLaunchable\(\)\) notFound\(\)/)
  assert.match(raisePage, /<BundleRaise initial=\{state\} depositsOpen=\{bundleLaunchable\(\)\}\/>/)
  assert.match(source('app/(site)/token/[mint]/page.jsx'), /\.\.\.isBundleMarket\(market\) \? \[\{ id: 'bundle'/)
})

test('the launch form offers a Bundle only when the page passes its terms', async () => {
  const { LaunchForm } = await appModule('app/components/launch-form.jsx')
  const repo = { repoId: REPO, name: 'widget', fullName: 'octo/widget', source: 'github' }
  assert.doesNotMatch(html(h(LaunchForm, { repo, available: true }), { wallet: true }), /community-funded|How to launch/)
  const offered = html(h(LaunchForm, { repo, available: true, bundle: bundleFormSettings() }), { wallet: true })
  assert.match(offered, /How to launch/)
  assert.match(offered, /Bundle <span class="muted">\(community-funded\)<\/span>/)
  // Not for an agent draft or a trend launch, like early access.
  assert.doesNotMatch(html(h(LaunchForm, { repo, available: true, bundle: bundleFormSettings(), trendRevision: 3 }), { wallet: true }), /community-funded/)
  const { BundleNotes, BundleRaiseFields } = await appModule('app/components/launch-bundle.jsx')
  const notes = html(h(BundleNotes, { settings: bundleFormSettings() }))
  for (const fact of [/80% of this market&#x27;s partner trading fees/, /own\s+trading fees are paid back to it/, /never paid out/, /about 0.017 SOL/,
    /one market in 52 earned 3.8 SOL/, /full\s*<!-- -->?\s*refund|returns every deposit in full/]) assert.match(notes, fact)
  const fields = html(h(BundleRaiseFields, { settings: bundleFormSettings(), value: { target: '5', days: 3 }, onChange() {} }))
  assert.match(fields, /1 SOL.*3 SOL.*5 SOL.*10 SOL/s)
  assert.match(fields, />1 day<.*>3 days<.*>7 days</s)
  assert.match(fields, /less 5% for operations/)
})

test('opening: refused for bad terms, token fields, a model, an opt-out, a copy, a market, or a live bundle; nothing is reserved', async t => {
  quiet(t)
  const refused = async (body, overrides, hasMarket) => {
    const { api, pool } = harness({ overrides, hasMarket })
    const result = await call(api.open(post('/api/bundles', body)))
    assert.equal(pool.queries.filter(query => /nextval|insert into bundles/.test(query.sql)).length, 0, 'no id or row')
    return result
  }
  assert.deepEqual(await refused(openBody({ targetLamports: String(11n * SOL) })), { status: 400, body: { error: RAISE_REFUSALS.target } })
  assert.deepEqual(await refused(openBody({ deadlineDays: 2 })), { status: 400, body: { error: RAISE_REFUSALS.deadline } })
  assert.deepEqual(await refused(openBody({ tokenSymbol: 'TOOLONGSYMBOL' })), { status: 400, body: { error: RAISE_REFUSALS.token } })
  assert.deepEqual(await refused(openBody({ tokenImage: '' })), { status: 400, body: { error: 'Choose a token image before reviewing the launch.' } })
  assert.deepEqual(await refused(openBody({ launcherWallet: 'nope' })), { status: 400, body: { error: RAISE_REFUSALS.wallet } })
  assert.deepEqual(await refused(openBody({ launcherWallet: admin.publicKey.toBase58() })), { status: 400, body: { error: RAISE_REFUSALS.creator } })
  assert.deepEqual(await refused(openBody({ repoId: '4503599627370497' })), { status: 400, body: { error: RAISE_REFUSALS.repository } })
  assert.deepEqual(await refused(openBody(), { launchAllowed: async () => { throw new DecisionError(OPT_OUT_ERROR, 403, 'MAINTAINER_OPTED_OUT') } }),
    { status: 403, body: { error: OPT_OUT_ERROR, code: 'MAINTAINER_OPTED_OUT' } })
  const copy = await refused(openBody(), { lineage: async () => { throw new LineageError('This repository is a copy of octo/original, which already has a market.') } })
  assert.deepEqual([copy.status, copy.body.code], [409, 'COPY_OF_LAUNCHED_REPOSITORY'])
  assert.deepEqual(await refused(openBody(), {}, true), { status: 409, body: { error: RAISE_REFUSALS.market } })
  // A transport failure never reaches the page.
  const broken = await refused(openBody(), { resolveRepository: async () => { throw Error('connect ECONNREFUSED 10.0.0.3:5432') } })
  assert.deepEqual(broken, { status: 503, body: { error: 'Bundles are temporarily unavailable. Try again shortly.' } })

  const { api, pool } = harness()
  pool.bundles.set('3', { bundleId: '3', githubRepoId: REPO, status: 'raising' })
  assert.deepEqual(await call(api.open(post('/api/bundles', openBody()))), { status: 409, body: { error: RAISE_REFUSALS.live } })
  pool.bundles.set('3', { bundleId: '3', githubRepoId: REPO, status: 'opening' })
  assert.deepEqual(await call(api.open(post('/api/bundles', openBody()))), { status: 409, body: { error: RAISE_REFUSALS.opening } })
})

test('opening: a simulated failure is refused in plain words before any row exists', async t => {
  quiet(t)
  const { api, chain, pool } = harness()
  chain.simulation = { err: { InstructionError: [2, { Custom: 6009 }] }, unitsConsumed: 0,
    logs: [`Program ${BUNDLE_VAULT_PROGRAM_ID.toBase58()} failed: custom program error: 0x1779`] }
  assert.deepEqual(await call(api.open(post('/api/bundles', openBody()))), { status: 400, body: { error: 'Solana refused these raise terms. Open the bundle again.' } })
  assert.equal(pool.queries.filter(query => /insert into bundles/.test(query.sql)).length, 0)
  assert.equal(simulationFailure(['Transfer: insufficient lamports 1, need 2']), 'Your wallet does not have enough SOL for this and its network fee.')
})

// Prepares an opening for `creator` and returns what the wallet received.
async function prepared(h, body = openBody()) {
  const result = await call(h.api.open(post('/api/bundles', body)))
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}

test('opening: the create transaction is [limit, price, create_bundle] with the creator then the admin as signers, and the row is opening', async () => {
  const h = harness()
  const body = await prepared(h)
  assert.equal(body.bundleId, '7')
  assert.equal(body.address, bundleAddress(7n).toBase58())
  const tx = transactionOf(body.transaction)
  assert.equal(tx.feePayer.toBase58(), creator.publicKey.toBase58())
  assert.deepEqual(tx.instructions.map(ix => ix.programId.toBase58()),
    [ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), BUNDLE_VAULT_PROGRAM_ID.toBase58()])
  sameInstruction(tx.instructions[2], createBundleInstruction({ creator: creator.publicKey, admin: admin.publicKey, id: 7n, repoId: BigInt(REPO),
    target: 5n * SOL, minDeposit: 50_000_000n, deadline: NOW / 1000 + 3 * 86_400, policy: BUNDLE_DEFAULTS.policy }))
  const message = tx.compileMessage()
  assert.equal(message.header.numRequiredSignatures, 2)
  assert.deepEqual(message.accountKeys.slice(0, 2).map(String), [creator.publicKey, admin.publicKey].map(String), 'creator, then admin')
  assert.ok(tx.signatures.every(entry => entry.signature === null), 'nobody signed yet: the wallet signs first')
  const row = h.pool.bundles.get('7')
  assert.deepEqual([row.status, row.githubRepoId, row.creatorWallet, row.targetLamports, row.minDepositLamports, row.tokenSymbol, row.address],
    ['opening', REPO, creator.publicKey.toBase58(), String(5n * SOL), '50000000', 'WDGT', bundleAddress(7n).toBase58()])
  assert.equal(row.deadline.getTime(), NOW + 3 * 86_400_000)
})

const wire = tx => tx.serialize({ requireAllSignatures: false }).toString('base64')
const submit = (h, body, transaction, fields = {}) => call(h.api.open(post('/api/bundles', { action: 'submit', bundleId: body.bundleId, review: body.review,
  transaction: typeof transaction === 'string' ? transaction : wire(transaction), ...fields })))
// Landing the opening creates the Bundle account the row describes.
const landsAs = (h, row) => raw => {
  const landed = Transaction.from(raw)
  assert.ok(landed.verifySignatures(), 'creator and admin signatures')
  assert.deepEqual(landed.signatures.map(entry => entry.publicKey.toBase58()), [creator.publicKey, admin.publicKey].map(String))
  h.chain.setProgramAccount(bundleAddress(7n), bundleData({ id: 7n, repoId: BigInt(REPO), creator: creator.publicKey, target: 5n * SOL,
    minDeposit: 50_000_000n, deadline: row.deadline.getTime() / 1000 }))
}
const lighthouse = target => new TransactionInstruction({ programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
  keys: [{ pubkey: target, isSigner: false, isWritable: false }], data: Buffer.from([5, 0, 2, 0]) })

test('opening: submit co-signs once, only the prepared transaction under its sealed review, sends it and marks the row raising', async t => {
  quiet(t)
  const h = harness()
  const body = await prepared(h)
  assert.match(body.review, /^[\w-]+\.[\w-]+$/, 'a sealed review, not the blockhash in the clear')
  // An altered transaction, an unsigned one, a missing or forged review, another bundle's review: refused before anything is
  // co-signed, recorded or sent.
  const altered = transactionOf(body.transaction).add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: admin.publicKey, lamports: 1 }))
  altered.partialSign(creator)
  assert.deepEqual(await submit(h, body, altered), { status: 400, body: { error: RAISE_REFUSALS.altered } })
  assert.deepEqual(await submit(h, body, body.transaction), { status: 400, body: { error: RAISE_REFUSALS.unsigned } })
  const tx = transactionOf(body.transaction)
  tx.partialSign(creator)
  const [payload, mac] = body.review.split('.')
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), units: 1_400_000 })).toString('base64url')
  for (const review of [undefined, `${forged}.${mac}`, `${payload}.${mac}x`]) {
    assert.deepEqual(await submit(h, { ...body, review }, tx), { status: 400, body: { error: RAISE_REFUSALS.expired } })
  }
  // The same instructions under a blockhash of the client's choosing are not the prepared message.
  const rehashed = new Transaction({ feePayer: creator.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(...tx.instructions)
  rehashed.partialSign(creator)
  assert.deepEqual(await submit(h, body, rehashed), { status: 400, body: { error: RAISE_REFUSALS.altered } })
  assert.equal(h.pool.bundles.get('7').createSignature, null)
  assert.equal(h.chain.sent.length, 0)

  h.chain.onSend = landsAs(h, h.pool.bundles.get('7'))
  assert.deepEqual(await submit(h, body, tx), { status: 200, body: { bundleId: '7', signature: bs58.encode(tx.signature), status: 'raising' } })
  assert.equal(h.chain.sent.length, 1)
  assert.deepEqual([h.pool.bundles.get('7').status, h.pool.bundles.get('7').createSignature], ['raising', bs58.encode(tx.signature)])
  // The decision ran in a transaction under the bundle's own lock.
  const locked = h.pool.queries.filter(query => query.client && /pg_advisory_xact_lock|^(begin|commit|rollback)$/.test(query.sql.trim()))
    .map(query => query.sql.trim().split('(')[0])
  assert.deepEqual(locked.slice(locked.lastIndexOf('begin')), ['begin', 'select pg_advisory_xact_lock', 'commit'])
  assert.equal(locked.filter(sql => sql === 'rollback').length, 3, 'the three refused transactions rolled back; a bad review never took the lock')
  // Repeating it answers the same and sends nothing.
  const again = await submit(h, body, tx)
  assert.deepEqual([again.status, again.body.status, h.chain.sent.length], [200, 'raising', 1])
})

test('opening: a second co-sign of the same row is refused; a repeat answers from the chain', async t => {
  quiet(t)
  const h = harness()
  const body = await prepared(h)
  // A first submit was recorded and sent but has not landed yet (its answer was lost).
  h.pool.bundles.set('7', { ...h.pool.bundles.get('7'), createSignature: 'FirstSignature' })
  const other = transactionOf(body.transaction).add(lighthouse(creator.publicKey))
  other.partialSign(creator)
  assert.deepEqual(await submit(h, body, other), { status: 202, body: { bundleId: '7', signature: 'FirstSignature', status: 'opening', pending: true } })
  assert.equal(h.chain.sent.length, 0, 'never co-signed or sent again')
  // Once it landed, a repeat marks the row raising with the recorded signature, still without co-signing.
  const row = h.pool.bundles.get('7')
  h.chain.setProgramAccount(bundleAddress(7n), bundleData({ id: 7n, repoId: BigInt(REPO), creator: creator.publicKey, target: 5n * SOL,
    minDeposit: 50_000_000n, deadline: row.deadline.getTime() / 1000 }))
  assert.deepEqual(await submit(h, body, other), { status: 200, body: { bundleId: '7', signature: 'FirstSignature', status: 'raising' } })
  assert.deepEqual([h.pool.bundles.get('7').status, h.chain.sent.length], ['raising', 0])
})

test('opening: wallet assertions may name only the creator, never the admin; the creator cannot be the admin; slots must match', async t => {
  quiet(t)
  const h = harness()
  const body = await prepared(h)
  const onAdmin = transactionOf(body.transaction).add(lighthouse(admin.publicKey))
  onAdmin.partialSign(creator)
  assert.deepEqual(await submit(h, body, onAdmin), { status: 400, body: { error: RAISE_REFUSALS.altered } })
  // One signature slot too many on the wire.
  const signed = transactionOf(body.transaction)
  signed.partialSign(creator)
  const bytes = signed.serialize({ requireAllSignatures: false })
  const padded = Buffer.concat([Buffer.from([bytes[0] + 1]), bytes.subarray(1, 1 + 64 * bytes[0]), Buffer.alloc(64), bytes.subarray(1 + 64 * bytes[0])])
  assert.deepEqual(await submit(h, body, padded.toString('base64')), { status: 400, body: { error: RAISE_REFUSALS.altered } })
  const asserted = transactionOf(body.transaction).add(lighthouse(creator.publicKey))
  asserted.partialSign(creator)
  h.chain.onSend = landsAs(h, h.pool.bundles.get('7'))
  assert.equal((await submit(h, body, asserted)).body.status, 'raising', 'an assertion on the creator is the wallet\'s own')
  const review = openBundleReview(bundleReviewKey(admin.secretKey), body.review, 7n)
  assert.throws(() => acceptSignedCreate({ ...h.pool.bundles.get('7'), creatorWallet: admin.publicKey.toBase58() }, admin, wire(asserted), review),
    { message: RAISE_REFUSALS.creator })
})

test('opening: a review older than two minutes is never co-signed', async () => {
  const h = harness()
  const body = await prepared(h)
  const tx = transactionOf(body.transaction)
  tx.partialSign(creator)
  h.pool.bundles.set('7', { ...h.pool.bundles.get('7'), ageMs: '121000' })
  assert.deepEqual(await submit(h, body, tx), { status: 400, body: { error: RAISE_REFUSALS.expired } })
  assert.equal(h.chain.sent.length, 0)
})

test('opening: under the repository lock, a stale unsigned opening is replaced, a live one is not, and a wallet may wait on two at most', async () => {
  const h = harness()
  await prepared(h)
  const refusedFor = async () => (await call(h.api.open(post('/api/bundles', openBody({ launcherWallet: backer.publicKey.toBase58() }))))).body.error
  assert.equal(await refusedFor(), RAISE_REFUSALS.opening, 'young')
  h.pool.bundles.set('7', { ...h.pool.bundles.get('7'), ageMs: String(5 * 60_000 + 1) })
  h.chain.setProgramAccount(bundleAddress(7n), bundleData({ id: 7n }))
  assert.equal(await refusedFor(), RAISE_REFUSALS.opening, 'its account exists: it landed')
  h.chain.accounts.delete(bundleAddress(7n).toBase58())
  const replaced = await call(h.api.open(post('/api/bundles', openBody({ launcherWallet: backer.publicKey.toBase58() }))))
  assert.equal(replaced.status, 200)
  assert.deepEqual([h.pool.bundles.get('7').status, replaced.body.bundleId, h.pool.bundles.get(replaced.body.bundleId).status], ['expired', '8', 'opening'])
  // Checks, replacement and insert all ran on the locked connection, between lock and unlock on the repository id.
  const onClient = h.pool.queries.filter(query => query.client).map(query => query.sql.trim())
  const lock = onClient.lastIndexOf('select pg_advisory_lock($1::bigint)'), unlock = onClient.lastIndexOf('select pg_advisory_unlock($1::bigint)')
  assert.ok(lock >= 0 && unlock > lock)
  assert.deepEqual(onClient.slice(lock + 1, unlock).map(sql => sql.split(/\s+/).slice(0, 2).join(' ')),
    ['select exists(select', 'update bundles', 'select count(*)::int', "select nextval('bundle_id_seq')::text", 'insert into'])
  assert.deepEqual(h.pool.queries.find(query => query.sql.includes('pg_advisory_lock')).params, [REPO])
  // Two waiting bundles for one wallet (other repositories): a third is refused.
  const capped = harness()
  for (const id of ['1', '2']) capped.pool.bundles.set(id, { bundleId: id, githubRepoId: `1${id}`, creatorWallet: creator.publicKey.toBase58(), status: 'opening' })
  assert.deepEqual(await call(capped.api.open(post('/api/bundles', openBody()))), { status: 429, body: { error: RAISE_REFUSALS.wallets } })
})

test('limits: opening counts as a launch review, its submit and every relay have their own allowance', async () => {
  const counted = []
  const h = harness({ overrides: { limit: (request, action) => { counted.push(action); return null } } })
  raising(h)
  await call(h.api.open(post('/api/bundles', openBody({ repoId: '1' }))))
  await call(h.api.open(post('/api/bundles', { action: 'submit', bundleId: '7' })))
  await call(h.api.read(get('/api/bundles/7'), '7'))
  await act(h, { action: 'deposit', lamports: String(SOL) })
  await act(h, { action: 'send', transaction: 'AA==' })
  assert.deepEqual(counted, ['launch:prepare', 'bundle:submit', 'bundle:read', 'bundle:prepare', 'bundle:send'])
  const refused = harness({ overrides: { limit: () => Response.json({ error: 'Too many requests. Try again in 3 seconds.', code: 'RATE_LIMITED' }, { status: 429 }) } })
  assert.equal((await call(refused.api.open(post('/api/bundles', { action: 'submit', bundleId: '7' })))).status, 429)
  assert.equal((await act(refused, { action: 'send', transaction: 'AA==' })).status, 429)
})

test('token fields fit Metaplex\'s byte caps and carry no hidden characters; bundle ids stay within bigint', async () => {
  assert.throws(() => tokenFields({ tokenName: 'é'.repeat(17), tokenSymbol: 'W' }), { message: RAISE_REFUSALS.tokenBytes })
  assert.throws(() => tokenFields({ tokenName: 'Widget', tokenSymbol: 'ÉÉÉÉÉÉ' }), { message: RAISE_REFUSALS.tokenBytes })
  for (const hidden of ['​', '‍', '‮', '⁦', '﻿', '\u0007', '\n', '­']) {
    assert.throws(() => tokenFields({ tokenName: `Wid${hidden}get`, tokenSymbol: 'W' }), { message: RAISE_REFUSALS.tokenCharacters }, JSON.stringify(hidden))
    assert.throws(() => tokenFields({ tokenName: 'Widget', tokenSymbol: `W${hidden}` }), { message: RAISE_REFUSALS.tokenCharacters }, JSON.stringify(hidden))
  }
  assert.deepEqual(tokenFields({ tokenName: 'Ünïcødé ✓', tokenSymbol: 'ÜÑ' }), { tokenName: 'Ünïcødé ✓', tokenSymbol: 'ÜÑ' })
  assert.deepEqual([bundleIdFrom('9223372036854775807'), bundleIdFrom('9223372036854775808'), bundleIdFrom('9999999999999999999'), bundleIdFrom('0'),
    bundleIdFrom('07'), bundleIdFrom(7)], [9223372036854775807n, null, null, null, null, 7n])
  const h = harness()
  assert.equal((await call(h.api.read(get('/api/bundles/9223372036854775808'), '9223372036854775808'))).status, 404)
  assert.equal(h.pool.queries.length, 0, 'never reaches PostgreSQL')
})

test('reads: one backer count per bundle per 30 s; /wallet\'s Backer read follows the bundle:read limit', async () => {
  const h = harness()
  raising(h)
  await call(h.api.read(get('/api/bundles/7'), '7'))
  await call(h.api.read(get('/api/bundles/7'), '7'))
  assert.equal(h.chain.programReads.length, 1)
  let at = 0
  const count = createBackerCounter({ now: () => at })
  await count(h.chain, 7n); at = 29_999; await count(h.chain, 7n)
  assert.equal(h.chain.programReads.length, 2)
  at = 30_000; await count(h.chain, 7n)
  assert.equal(h.chain.programReads.length, 3)
  assert.deepEqual(await walletBundleFields(h.pool, () => h.chain, backer.publicKey.toBase58(), { allowed: () => false }), { bundles: null })
  assert.equal(h.chain.programReads.length, 3, 'no Backer read when refused')
})

// A raising bundle 7 on chain with its site row; `fields` override the chain account.
function raising(h, fields = {}) {
  h.pool.bundles.set('7', { bundleId: '7', githubRepoId: REPO, address: bundleAddress(7n).toBase58(), creatorWallet: creator.publicKey.toBase58(), tokenName: 'Widget',
    tokenSymbol: 'WDGT', targetLamports: String(5n * SOL), minDepositLamports: '50000000', deadline: new Date(NOW + 86_400_000), status: 'raising',
    createSignature: null, createdAt: new Date(NOW), fullName: 'octo/widget', owner: 'octo', name: 'widget', avatarUrl: null, description: null, marketMint: null })
  h.chain.setProgramAccount(bundleAddress(7n), bundleData({ id: 7n, repoId: BigInt(REPO), creator: creator.publicKey, target: 5n * SOL, minDeposit: 50_000_000n,
    deadline: NOW / 1000 + 86_400, raised: 4n * SOL, ...fields }))
}
const act = (h, body) => call(h.api.act(post('/api/bundles/7', { wallet: backer.publicKey.toBase58(), ...body }), '7'))

test('deposit: checked against the chain (raising, before the deadline, within the target, from the minimum unless it fills it)', async () => {
  const h = harness()
  raising(h)
  assert.deepEqual(await act(h, { action: 'deposit', lamports: '49999999' }), { status: 400,
    body: { error: 'Deposits start at 0.05 SOL; only the deposit that fills the raise may be smaller.' } })
  assert.deepEqual(await act(h, { action: 'deposit', lamports: String(SOL + 1n) }), { status: 400, body: { error: 'This raise needs only 1 SOL more.' } })
  assert.deepEqual(await act(h, { action: 'deposit', lamports: '0' }), { status: 400, body: { error: RAISE_REFUSALS.amount } })
  const ok = await act(h, { action: 'deposit', lamports: String(SOL) })
  assert.equal(ok.status, 200)
  const tx = transactionOf(ok.body.transaction)
  assert.equal(tx.feePayer.toBase58(), backer.publicKey.toBase58())
  assert.equal(tx.instructions.length, 3)
  sameInstruction(tx.instructions[2], depositInstruction({ wallet: backer.publicKey, id: 7n, lamports: SOL }))
  raising(h, { raised: 5n * SOL - 1_000n })
  assert.equal((await act(h, { action: 'deposit', lamports: '1000' })).status, 200, 'the last deposit may be below the minimum')
  raising(h, { deadline: NOW / 1000 - 1 })
  assert.deepEqual(await act(h, { action: 'deposit', lamports: String(SOL) }), { status: 400, body: { error: 'This raise passed its deadline.' } })
  raising(h, { status: STATUS.FAILED })
  assert.deepEqual(await act(h, { action: 'deposit', lamports: String(SOL) }), { status: 400, body: { error: 'This raise is not taking deposits.' } })
  assert.equal((await call(h.api.act(post('/api/bundles/8', { action: 'deposit', wallet: backer.publicKey.toBase58(), lamports: String(SOL) }), '8'))).status, 404)
})

test('refund: only after a raise failed, only for a backer, and exactly the program\'s refund', async () => {
  const h = harness()
  raising(h)
  assert.deepEqual(await act(h, { action: 'refund' }), { status: 400, body: { error: 'Refunds open only after a raise fails.' } })
  raising(h, { status: STATUS.FAILED })
  assert.deepEqual(await act(h, { action: 'refund' }), { status: 400, body: { error: 'This wallet has no deposit in this bundle.' } })
  h.chain.setProgramAccount(backerAddress(bundleAddress(7n), backer.publicKey), backerData({ bundle: bundleAddress(7n), wallet: backer.publicKey, shares: SOL }))
  const ok = await act(h, { action: 'refund' })
  assert.equal(ok.status, 200)
  const tx = transactionOf(ok.body.transaction)
  assert.equal(tx.instructions.length, 3)
  sameInstruction(tx.instructions[2], refundInstruction({ wallet: backer.publicKey, id: 7n }))
})

test('claim: wraps into the wallet\'s wrapped SOL account and unwraps it to SOL in one transaction; an existing account is kept', async () => {
  const h = harness()
  raising(h, { status: STATUS.LAUNCHED, raised: 5n * SOL, accPerShare: 2n * 10n ** 15n })
  const backerKey = backerAddress(bundleAddress(7n), backer.publicKey)
  h.chain.setProgramAccount(backerKey, backerData({ bundle: bundleAddress(7n), wallet: backer.publicKey, shares: SOL, paid: 2_000_000n }))
  assert.deepEqual(await act(h, { action: 'claim' }), { status: 400, body: { error: 'There is nothing to claim yet.' } })
  h.chain.setProgramAccount(backerKey, backerData({ bundle: bundleAddress(7n), wallet: backer.publicKey, shares: SOL, paid: 1_000_000n }))
  const wrapped = tokenAccountOf(backer.publicKey, NATIVE_MINT)
  const check = instructions => {
    const [create, claim, close, again] = instructions
    assert.equal(create.programId.toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    assert.deepEqual([...create.data], [1], 'idempotent')
    assert.deepEqual(create.keys.map(k => k.pubkey.toBase58()), [backer.publicKey, wrapped, backer.publicKey, NATIVE_MINT, SystemProgram.programId, TOKEN_PROGRAM_ID].map(String))
    sameInstruction(claim, claimBackerFeesInstruction({ wallet: backer.publicKey, id: 7n, destination: wrapped }))
    assert.equal(close.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58())
    assert.deepEqual([...close.data], [9], 'CloseAccount')
    assert.deepEqual(close.keys.map(k => k.pubkey.toBase58()), [wrapped, backer.publicKey, backer.publicKey].map(String), 'unwrapped to the wallet')
    return again
  }
  const fresh = await act(h, { action: 'claim' })
  assert.equal(fresh.status, 200)
  const tx = transactionOf(fresh.body.transaction)
  assert.equal(tx.instructions.length, 5)
  assert.equal(check(tx.instructions.slice(2)), undefined, 'a new account is closed and not kept')
  // The wallet already has the account (its referral payouts land there): it is created again after the close.
  h.chain.set(wrapped, TOKEN_PROGRAM_ID, Buffer.alloc(165))
  const kept = transactionOf((await act(h, { action: 'claim' })).body.transaction)
  assert.equal(kept.instructions.length, 6)
  assert.deepEqual([...check(kept.instructions.slice(2)).data], [1])
})

test('send: relays only a transaction the site built for this wallet and bundle, signed by the wallet', async t => {
  quiet(t)
  const h = harness()
  raising(h)
  const ok = await act(h, { action: 'deposit', lamports: String(SOL) })
  const tx = transactionOf(ok.body.transaction)
  const send = transaction => act(h, { action: 'send', transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64'), lastValidBlockHeight: 1_000 })
  assert.deepEqual(await send(tx), { status: 400, body: { error: RAISE_REFUSALS.unsigned } })
  // Another bundle, an extra instruction, or another wallet's signature: refused, nothing sent.
  const other = new Transaction({ feePayer: backer.publicKey, recentBlockhash: tx.recentBlockhash }).add(tx.instructions[0], tx.instructions[1],
    depositInstruction({ wallet: backer.publicKey, id: 8n, lamports: SOL }))
  other.sign(backer)
  const extra = transactionOf(ok.body.transaction).add(SystemProgram.transfer({ fromPubkey: backer.publicKey, toPubkey: admin.publicKey, lamports: 1 }))
  extra.sign(backer)
  for (const refused of [other, extra]) assert.deepEqual(await send(refused), { status: 400, body: { error: RAISE_REFUSALS.altered } })
  assert.equal(h.chain.sent.length, 0)
  tx.sign(backer)
  assert.deepEqual(await send(tx), { status: 200, body: { action: 'deposit', signature: bs58.encode(tx.signature), confirmed: true } })
  assert.deepEqual(h.chain.sent, [tx.serialize()])
  // The wallet may append its own Lighthouse assertion (Phantom); the deposit is still recognized.
  const asserted = transactionOf(ok.body.transaction).add(new TransactionInstruction({ programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
    keys: [{ pubkey: backer.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([5, 0, 2, 0]) }))
  asserted.sign(backer)
  assert.equal(acceptSignedAction({ id: 7n, wallet: backer.publicKey.toBase58(), transactionBase64: asserted.serialize().toString('base64') }).action, 'deposit')
})

test('read: the row, the chain\'s raise, the backer count and the wallet\'s share and claimable fees', async () => {
  const h = harness()
  raising(h, { status: STATUS.LAUNCHED, raised: 5n * SOL, accPerShare: 2n * 10n ** 15n, backerIncome: 10_000_000n, vaultRebated: 7n, treasuryIncome: 2_500_000n })
  h.chain.setProgramAccount(backerAddress(bundleAddress(7n), backer.publicKey), backerData({ bundle: bundleAddress(7n), wallet: backer.publicKey, shares: SOL }))
  h.chain.setProgramAccount(backerAddress(bundleAddress(7n), creator.publicKey), backerData({ bundle: bundleAddress(7n), wallet: creator.publicKey, shares: 4n * SOL }))
  h.chain.setProgramAccount(backerAddress(bundleAddress(9n), creator.publicKey), backerData({ bundle: bundleAddress(9n), wallet: creator.publicKey, shares: SOL }))
  const { status, body } = await call(h.api.read(get(`/api/bundles/7?wallet=${backer.publicKey.toBase58()}`), '7'))
  assert.equal(status, 200)
  assert.deepEqual([body.id, body.fullName, body.tokenSymbol, body.siteStatus, body.backers], ['7', 'octo/widget', 'WDGT', 'raising', 2])
  assert.deepEqual([body.chain.status, body.chain.raised, body.chain.target, body.chain.backerIncome, body.chain.vaultRebated, body.chain.treasuryIncome],
    ['launched', String(5n * SOL), String(5n * SOL), '10000000', '7', '2500000'])
  assert.deepEqual(body.wallet, { address: backer.publicKey.toBase58(), backer: { shares: String(SOL), paid: '0', pending: '2000000', shareBps: 2_000 } })
  const [count] = h.chain.programReads
  assert.deepEqual(count.filters.map(filter => filter.memcmp.offset), [0, 8], 'Backer accounts of this bundle')
  assert.equal(count.filters[1].memcmp.bytes, bundleAddress(7n).toBase58())
  assert.deepEqual(count.dataSlice, { offset: 0, length: 0 })
  assert.equal((await call(h.api.read(get('/api/bundles/8'), '8'))).status, 404)
  assert.equal((await call(h.api.read(get('/api/bundles/x'), 'x'))).status, 404)

  // /wallet: the wallet's Backer accounts (wallet at offset 40) and their bundles.
  const fields = await walletBundleFields(h.pool, () => h.chain, creator.publicKey.toBase58())
  assert.deepEqual(fields.bundles.map(item => [item.id, item.backer.shares, item.backer.shareBps]), [['7', String(4n * SOL), 8_000]], 'bundle 9 is not the site\'s')
  assert.deepEqual(h.chain.programReads.at(-1).filters.map(filter => filter.memcmp.offset), [0, 40])
})

test('the page\'s view of a raise: its phase, its percent and the time left', () => {
  const state = (chain, siteStatus = 'raising') => ({ siteStatus, chain, terms: { target: '5', minDeposit: '1', deadline: '2026-10-07T12:00:00Z' } })
  const live = { status: 'raising', raised: '1', target: '4', deadline: '2026-10-07T12:00:00.000Z' }
  assert.equal(raisePhase(state(null, 'opening'), NOW), 'opening')
  assert.equal(raisePhase(state(null, 'expired'), NOW), 'expired')
  assert.equal(raisePhase(state(live), NOW), 'raising')
  assert.equal(raisePhase(state(live), NOW + 2 * 86_400_000), 'closing')
  assert.equal(raisePhase(state({ ...live, raised: '4' }), NOW), 'full')
  assert.equal(raisePhase(state({ ...live, raised: '4' }, 'launching'), NOW), 'launching')
  assert.equal(raisePhase(state({ ...live, status: 'failed' }), NOW), 'failed')
  assert.equal(raisePhase(state({ ...live, status: 'launched' }), NOW), 'launched')
  for (const phase of ['opening', 'expired', 'raising', 'closing', 'full', 'launching', 'launched', 'failed']) assert.ok(PHASE_LABELS[phase])
  assert.deepEqual([raisedPercent('1', '4'), raisedPercent('5', '4'), raisedPercent('1', '3')], [25, 100, 33.33])
  assert.deepEqual([timeLeft('2026-10-08T16:30:00Z', NOW), timeLeft('2026-10-06T15:12:00Z', NOW), timeLeft('2026-10-06T12:12:30Z', NOW), timeLeft('2026-10-06T11:00:00Z', NOW)],
    ['2d 4h left', '3h 12m left', '12m 30s left', null])
  assert.equal(decodeBundle(bundleData({ id: 7n, target: 5n })).target, 5n, 'the fixture writes the program\'s layout')
})

test('existing bundles while dark: read, refund, claim and their relay work; a deposit and its relay answer 404; /wallet lists them', async t => {
  quiet(t)
  const dark = harness({ overrides: { launchable: () => false } })
  raising(dark, { status: STATUS.FAILED })
  dark.chain.setProgramAccount(backerAddress(bundleAddress(7n), backer.publicKey), backerData({ bundle: bundleAddress(7n), wallet: backer.publicKey, shares: SOL }))
  assert.equal((await call(dark.api.read(get(`/api/bundles/7?wallet=${backer.publicKey.toBase58()}`), '7'))).body.wallet.backer.shares, String(SOL))
  assert.deepEqual(await call(dark.api.open(post('/api/bundles', openBody()))), { status: 404, body: { error: 'Not found' } })
  assert.deepEqual(await act(dark, { action: 'deposit', lamports: String(SOL) }), { status: 404, body: { error: 'Not found' } })
  const refund = await act(dark, { action: 'refund' })
  assert.equal(refund.status, 200)
  const signed = transactionOf(refund.body.transaction)
  signed.sign(backer)
  const sent = await act(dark, { action: 'send', transaction: signed.serialize().toString('base64'), lastValidBlockHeight: 1_000 })
  assert.deepEqual([sent.status, sent.body.action, sent.body.confirmed], [200, 'refund', true])
  // A deposit signed while launches were on is not relayed once they are off.
  const on = harness()
  raising(on)
  const deposit = transactionOf((await act(on, { action: 'deposit', lamports: String(SOL) })).body.transaction)
  deposit.sign(backer)
  assert.deepEqual(await act(dark, { action: 'send', transaction: deposit.serialize().toString('base64'), lastValidBlockHeight: 1_000 }), { status: 404, body: { error: 'Not found' } })
  assert.equal(dark.chain.sent.length, 1, 'only the refund')
  raising(dark, { status: STATUS.LAUNCHED, raised: 5n * SOL, accPerShare: 2n * 10n ** 15n })
  assert.equal((await act(dark, { action: 'claim' })).status, 200)
  // /wallet: the wallet's bundles whatever the switch says; no Backer read at all until the site has opened a bundle.
  assert.deepEqual((await walletBundleFields(dark.pool, () => dark.chain, backer.publicKey.toBase58())).bundles.map(item => item.id), ['7'])
  let read = false
  assert.deepEqual(await walletBundleFields(fakePool(), () => { read = true }, backer.publicKey.toBase58()), {})
  assert.equal(read, false)
  assert.deepEqual(await walletBundleFields(dark.pool, () => dark.chain, Keypair.generate().publicKey.toBase58()), {}, 'a wallet that backs none gets no field')
  // The raise page without new money: no deposit form, refunds and claims stay.
  const { BundleRaise } = await appModule('app/components/bundle-raise.jsx')
  const state = (await call(dark.api.read(get('/api/bundles/7'), '7'))).body
  raising(dark)
  const live = (await call(dark.api.read(get('/api/bundles/7'), '7'))).body
  assert.match(html(h(BundleRaise, { initial: live }), { wallet: true }), /Back this bundle/)
  assert.doesNotMatch(html(h(BundleRaise, { initial: live, depositsOpen: false }), { wallet: true }), /Back this bundle/)
  assert.match(html(h(BundleRaise, { initial: live, depositsOpen: false }), { wallet: true }), /New deposits are paused/)
  assert.equal(state.chain.status, 'launched')
})
