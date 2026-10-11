import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { register } from 'node:module'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair } from '@solana/web3.js'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { BUILDER_SHARE_BPS, builderShareTarget, cachedShareTotals, claimPackShares } from '../src/builder-pack-shares.mjs'
import { createCreditsPacks } from '../src/credits-packs.mjs'
import { CREDITS_SESSION_COOKIE, openCreditsSession } from '../src/credits-web.mjs'
import { builderClaimTicket, packBuilderTicket } from '../src/credits-tickets.mjs'
import { redeemHandoff } from '../src/repo-inference-handoff.mjs'

// The routes import next/server the way Next resolves it (tests/fixtures/jsx-hooks.mjs); they are loaded when a test needs them.
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))

// Real PostgreSQL with every committed migration (0069_pack_builder_shares): which repositories a pack may be opened for (one
// read), the table's own rule for the repository and rate, and the pack quote for a repository against a stand-in credit service
// that checks the signed ticket like the credit ledger and replays a quote under the same Idempotency-Key. Then the builder's
// side: the payout wallet holder's claim (an admin sign-in through the real handoff row, a signed ticket) and the share route.
const url = process.env.BUILDER_PACK_SHARES_TEST_DATABASE_URL
const SECRETS = { clientSecret: 'c'.repeat(40), assertionSecret: 'a'.repeat(40) }
const SHARES = { secret: SECRETS.assertionSecret, shareBps: BUILDER_SHARE_BPS }
const PRICE = 109_800_000
const HOLDER = '900'
const STOCK_MINT = 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX'

async function connect() {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_builder_pack_shares_test', 'Disposable builder pack shares test database required')
  const pool = new pg.Pool({ connectionString: url })
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  return pool
}

// 1001 qualifies (its payout wallet belongs to user 900); 1002 is declined by its maintainer; 1003 qualifies with no maintainer yet;
// 1004 never launched; 1005 is a stock pair; 1006 was declined and the decision withdrawn; 1007 has a market that is not indexed;
// 1008 is a known repository with no market row at all.
async function seed(pool) {
  await pool.query('truncate maintainer_opt_outs, repo_beneficiaries, markets, repositories restart identity cascade')
  for (const id of [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008]) {
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values($1,'octo',$2,$3,1,0,false,now())`,
      [id, `repo${id}`, `octo/repo${id}`])
  }
  await pool.query(`update repositories set full_name = 'octo/hello' where github_repo_id = 1001`)
  const market = (id, status, extra = '', values = []) => pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,
    launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at) values($1,$2,$3,$4,'w','w','T','T',$5,1,'finalized',now(),now())${extra}`, [id, status, `Mint${id}`, `Pool${id}`, `Sig${id}`, ...values])
  for (const id of [1001, 1002, 1003, 1006]) await market(id, 'confirmed')
  await pool.query(`insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol) values(1004,'reserved','w','w','T','T')`)
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,quote_asset_id,quote_mint,
    quote_registry_version,launch_slot,launch_finality,indexed_at,last_verified_at) values(1005,'confirmed','Mint1005','Pool1005','w','w','T','T','Sig1005','msft-xstock',$1,1,1,'finalized',now(),now())`, [STOCK_MINT])
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature)
    values(1007,'confirmed','Mint1007','Pool1007','w','w','T','T','Sig1007')`)
  await pool.query(`insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values(1001,${HOLDER},'HolderWallet')`)
  await pool.query(`insert into maintainer_opt_outs(github_repo_id,kind,github_user_id,note) values(1002,'decline',501,'Not ours')`)
  await pool.query(`insert into maintainer_opt_outs(github_repo_id,kind,github_user_id,created_at,withdrawn_at,withdrawn_by_github_user_id)
    values(1006,'opt_out',501,now() - interval '2 days',now() - interval '1 day',502)`)
}

test('real PostgreSQL: one read decides which repositories a pack may back', { skip: !url }, async () => {
  const pool = await connect()
  try {
    await seed(pool)
    const target = (repoId, buyerGithubUserId = '42') => builderShareTarget(pool, { repoId, buyerGithubUserId })
    const refused = (repoId, pattern, buyer) => assert.rejects(target(repoId, buyer), error => error.status === 400 && pattern.test(error.message), repoId)
    assert.deepEqual(await target('1001'), { repoId: '1001', fullName: 'octo/hello' })
    assert.deepEqual(await target('1003'), { repoId: '1003', fullName: 'octo/repo1003' }, 'no maintainer yet')
    assert.deepEqual(await target('1006'), { repoId: '1006', fullName: 'octo/repo1006' }, 'a withdrawn decision no longer counts')
    await refused('1001', /your own packs/, HOLDER)
    await refused('1002', /opted out/)
    await refused('1004', /no market on repo\.ing/)
    await refused('1005', /stock pair/i)
    await refused('1007', /no market on repo\.ing/)
    await refused('1008', /no market on repo\.ing/)
    await refused('4503599627370497', /GitHub repositories/)
    let reads = 0
    const counted = { query: (...args) => { reads++; return pool.query(...args) } }
    await builderShareTarget(counted, { repoId: '1001', buyerGithubUserId: '42' })
    assert.equal(reads, 1)
  } finally { await pool.end() }
})

test('real PostgreSQL: the table refuses a repository without a rate, a rate without a repository, and a rate outside 1..2000', { skip: !url }, async () => {
  const pool = await connect()
  try {
    await pool.query('truncate credit_pack_purchases')
    const insert = (repo, bps) => pool.query(`insert into credit_pack_purchases(github_user_id,github_login,pack_micro,idempotency_key,session_hash,network,status,
      builder_repo_id,builder_share_bps) values(44,'x',25000000,$1,repeat('0',64),'devnet','requested',$2,$3) returning builder_repo_id::text as repo, builder_share_bps as bps`,
    [randomBytes(8).toString('hex'), repo, bps])
    const check = /credit_pack_purchases_builder_check/
    await assert.rejects(insert(1001, null), check)
    await assert.rejects(insert(null, 1000), check)
    await assert.rejects(insert(1001, 0), check)
    await assert.rejects(insert(1001, 2001), check)
    await assert.rejects(insert(0, 1000), check)
    await assert.rejects(insert(4503599627370496, 1000), check)
    assert.deepEqual((await insert(null, null)).rows, [{ repo: null, bps: null }], 'a pack with no repository, as before')
    await pool.query(`update credit_pack_purchases set status='cancelled'`)
    assert.deepEqual((await insert(4503599627370495, 2000)).rows, [{ repo: '4503599627370495', bps: 2000 }])
  } finally { await pool.end() }
})

// The credit service: signs sessions in through the real handoff row, checks a builder ticket with the shared secret (like the
// credit ledger), and answers a repeated Idempotency-Key with the same quote, or a 409 for a different repository.
function creditService({ pool, treasury }) {
  const sessions = new Map(), quotes = new Map(), requests = []
  const state = { drop: false, otherRepo: null }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  const shown = quote => {
    const sol = (quote.lamports / 1e9).toFixed(9).replace(/\.?0+$/, '')
    return { id: quote.id, kind: 'pack', pack_micro: quote.pack, credit_micro: quote.pack, lamports: quote.lamports, price_micro_per_sol: PRICE, treasury,
      reference: quote.reference, network: 'devnet', status: 'awaiting_payment', review_pending: false, spin: null,
      builder_repo_id: state.otherRepo ?? quote.builderRepo, builder_share_bps: quote.builderShareBps, expires_at: new Date(quote.expires).toISOString(),
      solana_pay_url: `solana:${treasury}?amount=${sol}&reference=${quote.reference}&label=repo.ing%20AI%20credits` }
  }
  const fetchImpl = async (address, init = {}) => {
    const { pathname } = new URL(address), body = init.body ? JSON.parse(init.body) : null
    if (pathname === '/sessions') {
      const assertion = await redeemHandoff(pool, { audience: 'repo-inference', code: body.code, codeVerifier: body.code_verifier }, SECRETS)
      const token = `ses_${randomBytes(24).toString('hex')}`
      sessions.set(token, assertion.github_user_id)
      return json({ token, login: assertion.login, expires_at: new Date(Date.now() + 3600_000).toISOString() })
    }
    const user = sessions.get(String(init.headers?.authorization ?? '').replace('Bearer ', ''))
    if (!user) return json({ error: 'Sign in again.' }, 401)
    if (pathname !== '/packs' || init.method !== 'POST') return json({ error: 'Not found' }, 404)
    const key = init.headers['idempotency-key']
    requests.push({ key, body, user })
    const ticket = body.builder
    if (ticket) {
      const expected = packBuilderTicket(SECRETS.assertionSecret, { idempotencyKey: key, githubUserId: user, repoId: ticket.repo_id, shareBps: ticket.share_bps, issuedAt: ticket.issued_at })
      if (expected.signature !== ticket.signature) return json({ error: 'The builder ticket is not valid.' }, 400)
    }
    const made = quotes.get(key)
    if (made) return made.builderRepo === (ticket?.repo_id ?? null) ? json(shown(made)) : json({ error: 'Idempotency key reused with a different request' }, 409)
    const pack = body.pack_micro, lamports = Number((BigInt(pack) * 1_000_000_000n + BigInt(PRICE) - 1n) / BigInt(PRICE))
    const quote = { id: randomUUID(), pack, lamports, reference: Keypair.generate().publicKey.toBase58(), expires: Date.now() + 15 * 60_000,
      builderRepo: ticket?.repo_id ?? null, builderShareBps: ticket?.share_bps ?? null }
    quotes.set(key, quote)
    if (state.drop) { state.drop = false; throw new TypeError('fetch failed') }
    return json(shown(quote))
  }
  return { fetchImpl, quotes, requests, state }
}

const who = { githubUserId: '42', login: 'octo' }
async function world(pool) {
  await seed(pool)
  await pool.query('truncate credit_pack_purchases, auth_handoffs, agent_request_limits')
  const treasury = Keypair.generate().publicKey.toBase58()
  const service = creditService({ pool, treasury })
  const clock = { at: Date.now() }
  const settings = { origin: 'https://credits.test', treasury, network: 'devnet' }
  const githubVerifier = { currentIdentity: async () => ({ githubLogin: 'octo' }) }
  const stepsWith = builderShares => createCreditsPacks({ pool, connection: null, settings, githubVerifier, builderShares, fetchImpl: service.fetchImpl, now: () => clock.at })
  const row = async id => (await pool.query(`select status, builder_repo_id::text as repo, builder_share_bps as bps, idempotency_key from credit_pack_purchases where id=$1`, [id])).rows[0]
  const handoffs = async () => (await pool.query('select count(*)::int as n from auth_handoffs')).rows[0].n
  return { service, clock, steps: stepsWith(SHARES), stepsWith, row, handoffs }
}

test('real PostgreSQL: a pack for a repository stores it, signs a ticket for it, and shows the share; a pack for none asks as before', { skip: !url }, async () => {
  const pool = await connect()
  try {
    const { service, steps, stepsWith, row, handoffs } = await world(pool)

    // A repository that does not qualify is refused before any sign-in or request.
    await assert.rejects(steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1002', current: null }), error => error.status === 400 && /opted out/.test(error.message))
    assert.deepEqual([(await pool.query('select count(*)::int as n from credit_pack_purchases')).rows[0].n, service.requests.length, await handoffs()], [0, 0, 0])
    // With the switch off, a repository is refused; a pack for none still works, with the body it always had.
    const off = stepsWith(null)
    await assert.rejects(off.quote({ ...who, packMicro: '25000000', builderRepoId: '1001', current: null }), error => error.status === 400 && /not open right now/.test(error.message))
    assert.equal(service.requests.length, 0)
    const plain = await off.quote({ ...who, packMicro: '10000000', current: null })
    assert.deepEqual(service.requests.map(request => request.body), [{ pack_micro: 10_000_000 }])
    assert.deepEqual([plain.purchase.status, plain.purchase.builder, (await row(plain.purchase.id)).repo, (await row(plain.purchase.id)).bps], ['quoted', null, null, null])
    await steps.cancel({ id: plain.purchase.id, githubUserId: '42' })

    // A repository that qualifies: stored with the request, ticket signed for the stored facts, the quote checked against them.
    const quoted = await steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1001', current: null })
    assert.equal(quoted.purchase.status, 'quoted')
    assert.deepEqual(quoted.purchase.builder, { repoId: '1001', shareBps: 1000, shareMicro: '2500000' })
    const stored = await row(quoted.purchase.id)
    assert.deepEqual([stored.repo, stored.bps], ['1001', 1000])
    const { body, key } = service.requests.at(-1)
    assert.deepEqual(Object.keys(body).sort(), ['builder', 'pack_micro'])
    assert.deepEqual([body.pack_micro, body.builder.repo_id, body.builder.share_bps, key], [25_000_000, '1001', 1000, stored.idempotency_key])
    assert.ok(Number.isInteger(body.builder.share_bps))
    assert.equal(body.builder.signature, packBuilderTicket(SHARES.secret, { idempotencyKey: key, githubUserId: '42', repoId: '1001', shareBps: 1000, issuedAt: body.builder.issued_at }).signature)
    assert.equal((await steps.status({ githubUserId: '42', current: quoted.session })).purchase.builder.repoId, '1001', 'the status read carries it too')
    await steps.cancel({ id: quoted.purchase.id, githubUserId: '42' })
  } finally { await pool.end() }
})

test('real PostgreSQL: a lost answer is asked for again for the stored repository with a newly signed ticket and returns the same quote', { skip: !url }, async () => {
  const pool = await connect()
  try {
    const { service, clock, steps, stepsWith, row } = await world(pool)
    service.state.drop = true
    let lost
    await assert.rejects(steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1001', current: null }), error => { lost = error.session; return error.status === 503 })
    const [requested] = (await pool.query(`select id, status, builder_repo_id::text as repo from credit_pack_purchases`)).rows
    assert.deepEqual([requested.status, requested.repo], ['requested', '1001'])

    // The next click names another qualifying repository: the request keeps its own, and the ticket is signed again.
    clock.at += 2_000
    const again = await steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1003', current: lost })
    assert.deepEqual([again.purchase.id, again.purchase.status, again.purchase.builder.repoId], [Number(requested.id), 'quoted', '1001'])
    const [first, second] = service.requests
    assert.equal(first.key, second.key)
    assert.deepEqual([first.body.builder.repo_id, second.body.builder.repo_id], ['1001', '1001'])
    assert.notEqual(first.body.builder.issued_at, second.body.builder.issued_at)
    assert.notEqual(first.body.builder.signature, second.body.builder.signature)
    assert.equal(service.quotes.size, 1, 'one quote, replayed under the stored key')
    await steps.cancel({ id: again.purchase.id, githubUserId: '42' })

    // The switch goes off while a request waits: it is not asked for without its ticket; it can be cancelled.
    service.state.drop = true
    let waiting
    await assert.rejects(steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1003', current: null }), error => { waiting = error.session; return error.status === 503 })
    const before = service.requests.length
    await assert.rejects(stepsWith(null).quote({ ...who, packMicro: '25000000', current: waiting }), error => error.status === 400 && /Cancel this pack/.test(error.message))
    assert.equal(service.requests.length, before, 'nothing was asked')
    const open = (await pool.query(`select id, status from credit_pack_purchases where status = 'requested'`)).rows[0]
    assert.equal((await steps.cancel({ id: open.id, githubUserId: '42' })).purchase.status, 'cancelled')
    assert.equal((await row(open.id)).repo, '1003')
  } finally { await pool.end() }
})

test('real PostgreSQL: the repository read comes after the quote quota; a refused repository counts as a quote', { skip: !url }, async () => {
  const pool = await connect()
  try {
    const { service, steps, handoffs } = await world(pool)
    const hits = async () => (await pool.query(`select hits from agent_request_limits where scope = 'credits:pack:42'`)).rows[0]?.hits ?? 0
    // 1002 is declined by its maintainer: with quota left it is a 400 that uses one quote; with none left it is a 429 and the repository is not read.
    await assert.rejects(steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1002', current: null }), error => error.status === 400 && /opted out/.test(error.message))
    assert.equal(await hits(), 1)
    await pool.query(`update agent_request_limits set hits = 6 where scope = 'credits:pack:42'`)
    await assert.rejects(steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1002', current: null }), error => error.status === 429 && /Too many quotes/.test(error.message))
    await assert.rejects(steps.quote({ ...who, packMicro: '25000000', builderRepoId: '9999', current: null }), error => error.status === 429)
    assert.equal(await hits(), 6, 'a refused quote does not count again')
    assert.deepEqual([service.requests.length, await handoffs()], [0, 0])
    // Another account has its own quota.
    await assert.rejects(steps.quote({ ...who, githubUserId: '43', packMicro: '25000000', builderRepoId: '1002', current: null }), error => error.status === 400)
  } finally { await pool.end() }
})

test('real PostgreSQL: a quote that names another repository or rate ends the request and nothing is paid', { skip: !url }, async () => {
  const pool = await connect()
  try {
    const { service, steps, row } = await world(pool)
    service.state.otherRepo = '1003'
    let failed
    await assert.rejects(steps.quote({ ...who, packMicro: '25000000', builderRepoId: '1001', current: null }), error => { failed = error; return error.status === 502 && /Nothing was paid/.test(error.message) })
    assert.ok(failed)
    const [request] = (await pool.query(`select id, status from credit_pack_purchases`)).rows
    assert.equal(request.status, 'failed')
    assert.equal((await row(request.id)).repo, '1001')
  } finally { await pool.end() }
})

// The credit service for builder shares: signs a builder in through the real handoff row, answers a repository's totals, and
// answers a claim as the test scripts it (only for a session it signed in).
function sharesService({ pool }) {
  const requests = [], sessions = new Map()
  const state = { claim: { claimed_micro: 1_000_000, shares: 1 }, claimStatus: 200, totals: id => ({ repo_id: id, packs: 0, paid_micro: 0, claimed_micro: 0 }), down: false }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  const fetchImpl = async (address, init = {}) => {
    const { pathname } = new URL(address), body = init.body ? JSON.parse(init.body) : null
    requests.push({ pathname, method: init.method ?? 'GET', headers: init.headers ?? {}, body })
    if (state.down) throw new TypeError('fetch failed')
    if (pathname === '/sessions') {
      const assertion = await redeemHandoff(pool, { audience: 'repo-inference', code: body.code, codeVerifier: body.code_verifier }, SECRETS)
      const token = `ses_${randomBytes(24).toString('hex')}`
      sessions.set(token, assertion)
      return json({ token, login: assertion.login, expires_at: new Date(Date.now() + 3600_000).toISOString() })
    }
    if (pathname === '/builder-shares/claim') {
      if (!sessions.has(String(init.headers?.authorization ?? '').replace('Bearer ', ''))) return json({ error: 'Sign in again.' }, 401)
      return json(state.claim, state.claimStatus)
    }
    const total = (init.method ?? 'GET') === 'GET' && pathname.match(/^\/builder-shares\/(\d+)$/)
    return total ? json(state.totals(total[1])) : json({ error: 'Not found' }, 404)
  }
  return { fetchImpl, requests, sessions, state }
}

const AT = Date.parse('2026-10-11T12:00:00Z')
const CREDITS = { origin: 'https://credits.test', treasury: Keypair.generate().publicKey.toBase58(), network: 'devnet' }
const HOLDER_SESSION = { repoId: '1001', githubUserId: HOLDER, githubLogin: 'holder', permission: 'admin' }
async function claimWorld(pool) {
  await seed(pool)
  await pool.query('truncate auth_handoffs, agent_request_limits')
  const service = sharesService({ pool })
  const githubVerifier = { verifyCurrentAuthority: async () => ({ githubLogin: 'holder' }) }
  const claim = (extra = {}) => claimPackShares({ pool, settings: CREDITS, shares: SHARES, githubVerifier, session: HOLDER_SESSION, repoId: '1001',
    fetchImpl: service.fetchImpl, now: () => AT, ...extra })
  const handoffs = async () => (await pool.query('select count(*)::int as n from auth_handoffs')).rows[0].n
  const hits = async user => (await pool.query(`select hits from agent_request_limits where scope = $1`, [`credits:shares:${user}`])).rows[0]?.hits ?? 0
  return { service, claim, handoffs, hits }
}

test('real PostgreSQL: the payout wallet holder claims through an admin sign-in and a ticket the credit ledger can check', { skip: !url }, async () => {
  const pool = await connect()
  try {
    const { service, claim, handoffs, hits } = await claimWorld(pool)
    // The totals read before are kept for a minute; a claim drops them so the page shows what is left.
    service.state.totals = id => ({ repo_id: id, packs: 3, paid_micro: 3_000_000, claimed_micro: 0 })
    // A clock of its own (0): the entry is long stale for the routes below, which read the real clock.
    const readTotals = () => cachedShareTotals(CREDITS, '1001', { fetchImpl: service.fetchImpl, now: () => 0 })
    assert.equal((await readTotals()).unclaimedMicro, '3000000')
    service.state.totals = id => ({ repo_id: id, packs: 3, paid_micro: 3_000_000, claimed_micro: 1_000_000 })
    assert.equal((await readTotals()).unclaimedMicro, '3000000', 'kept')
    service.requests.length = 0

    const result = await claim()
    assert.deepEqual([result.claimedMicro, result.shares], ['1000000', 1])
    assert.deepEqual(service.requests.map(request => request.pathname), ['/sessions', '/builder-shares/claim'])
    const [token] = service.sessions.keys()
    assert.deepEqual(result.session, { token, githubUserId: HOLDER, expiresAt: AT + 55 * 60_000 })
    const [, sent] = service.requests
    assert.equal(sent.method, 'POST')
    assert.equal(sent.headers.authorization, `Bearer ${token}`)
    const key = sent.headers['idempotency-key']
    assert.match(key, /^[A-Za-z0-9_-]{22}$/)
    assert.deepEqual(Object.keys(sent.body).sort(), ['repo_id', 'ticket'])
    assert.equal(sent.body.repo_id, '1001')
    assert.deepEqual(Object.keys(sent.body.ticket).sort(), ['issued_at', 'signature'])
    assert.equal(sent.body.ticket.issued_at, '2026-10-11T12:00:00.000Z')
    assert.equal(sent.body.ticket.signature, builderClaimTicket(SHARES.secret, { idempotencyKey: key, githubUserId: HOLDER, repoId: '1001', issuedAt: sent.body.ticket.issued_at }).signature)
    // The sign-in was an admin handoff for this repository and this account, redeemed by the credit service.
    const { rows } = await pool.query(`select permission, github_repo_id::text as repo, github_user_id::text as "user", github_login as login, consumed_at is not null as consumed from auth_handoffs`)
    assert.deepEqual(rows, [{ permission: 'admin', repo: '1001', user: HOLDER, login: 'holder', consumed: true }])
    assert.deepEqual([service.sessions.get(token).permission, service.sessions.get(token).repo_id], ['admin', '1001'])
    assert.equal(await hits(HOLDER), 1)
    assert.equal((await readTotals()).unclaimedMicro, '2000000', 'the totals are read again after a claim')

    // A replay after a new sign-in answers 0: nothing new to claim, under a new key.
    service.state.claim = { claimed_micro: 0, shares: 0 }
    const replay = await claim()
    assert.deepEqual([replay.claimedMicro, replay.shares, replay.session.token === token], ['0', 0, false])
    const keys = service.requests.filter(request => request.pathname === '/builder-shares/claim').map(request => request.headers['idempotency-key'])
    assert.equal(new Set(keys).size, 2)
    assert.deepEqual([await hits(HOLDER), await handoffs()], [2, 2])
  } finally { await pool.end() }
})

test('real PostgreSQL: a claim by anyone but the payout wallet holder, or past the limit, signs in nowhere; the credit service\'s answers are checked', { skip: !url }, async () => {
  const pool = await connect()
  try {
    const { service, claim, handoffs, hits } = await claimWorld(pool)
    const nothing = async () => assert.deepEqual([service.requests.length, await handoffs(), await hits(HOLDER), await hits('901')], [0, 0, 0, 0])
    const forbidden = (extra, pattern) => assert.rejects(claim(extra), error => error.status === 403 && pattern.test(error.message))
    // Another account, a repository with no payout wallet bound, a failed live admin check: all before any quota or sign-in.
    await forbidden({ session: { ...HOLDER_SESSION, githubUserId: '901' } }, /payout wallet/)
    await forbidden({ session: { ...HOLDER_SESSION, repoId: '1003' }, repoId: '1003' }, /payout wallet/)
    await forbidden({ githubVerifier: { verifyCurrentAuthority: async () => { throw Error('no') } } }, /no longer lists you as an admin/)
    await forbidden({ session: { ...HOLDER_SESSION, permission: 'identity' } }, /admin of this repository/)
    await nothing()

    // Five claims in ten minutes.
    await pool.query(`insert into agent_request_limits(scope,hits,expires_at) values('credits:shares:900',5,now()+interval '10 minutes')`)
    await assert.rejects(claim(), error => error.status === 429 && /Too many claims/.test(error.message))
    assert.deepEqual([service.requests.length, await handoffs()], [0, 0])
    await pool.query('truncate agent_request_limits')

    // The credit service refuses, fails, or answers with something that is not a claim.
    const outcome = async (claimAnswer, status = 200) => {
      await pool.query('truncate agent_request_limits')
      service.state.claim = claimAnswer
      service.state.claimStatus = status
      return claim().then(() => null, error => [error.status, error.message])
    }
    assert.deepEqual(await outcome({ error: 'Not an admin session' }, 403), [502, 'Not an admin session'])
    assert.deepEqual(await outcome(null, 503), [502, 'The AI credits service answered HTTP 503.'])
    for (const odd of [{ claimed_micro: -1, shares: 1 }, { claimed_micro: 1.5, shares: 1 }, { claimed_micro: '1', shares: 1 }, { claimed_micro: 1, shares: null }, {}]) {
      assert.deepEqual(await outcome(odd), [502, 'The AI credits service returned an invalid claim.'], JSON.stringify(odd))
    }
    service.state.down = true
    assert.deepEqual(await outcome({ claimed_micro: 1, shares: 1 }), [503, 'The AI credits service could not be reached. Try again in a minute.'])
  } finally { await pool.end() }
})

// The share route against this database, GitHub and the credit service stood in for at the network (globalThis.fetch).
const ROUTE_ENV = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: SECRETS.assertionSecret,
  CREDITS_WEB_PACKS_ENABLED: 'true', CREDITS_WEB_BUILDER_SHARES_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing',
  CREDITS_TREASURY_ADDRESS: Keypair.generate().publicKey.toBase58(), GITHUB_APP_CLIENT_ID: 'Iv1.test-only', APP_ORIGIN: 'https://repo.ing' }
async function routeWorld(t, pool) {
  const keys = [...Object.keys(ROUTE_ENV), 'DATABASE_URL', 'GITHUB_APP_CLIENT_SECRET']
  const saved = { env: Object.fromEntries(keys.map(key => [key, process.env[key]])), pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  t.after(() => {
    for (const key of keys) saved.env[key] === undefined ? delete process.env[key] : process.env[key] = saved.env[key]
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
  })
  Object.assign(process.env, ROUTE_ENV, { DATABASE_URL: url, GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex') })
  globalThis.__gitfunPool = pool
  const { service, handoffs } = await claimWorld(pool)
  // GitHub, as the verifier calls it: the user, the repository (twice) and the user's permission on it.
  const github = { user: { id: 900, login: 'holder' } }
  globalThis.fetch = async (input, init) => {
    const address = new URL(String(input))
    if (address.origin === 'https://credits.repo.ing') return service.fetchImpl(String(input), init)
    assert.equal(address.origin, 'https://api.github.com')
    const body = address.pathname === '/user' ? github.user : address.pathname === '/repositories/1001' ? { id: 1001, owner: { login: 'octo' }, name: 'hello', private: false, archived: false }
      : address.pathname === `/repos/octo/hello/collaborators/${github.user.login}/permission` ? { permission: 'admin', user: { id: github.user.id } } : null
    return body ? Response.json(body) : new Response('not found', { status: 404 })
  }
  const route = await import('../app/api/credits/shares/[repo]/route.js')
  const session = extra => encryptGithubSession({ githubUserId: HOLDER, githubLogin: 'holder', accessToken: 'ghu_test_only', sessionId: randomBytes(24).toString('hex'),
    expiresAt: Date.now() + 60_000, ...extra })
  const call = async (method, repo, cookie, address) => {
    const response = await route[method]({ url: `https://repo.ing/api/credits/shares/${repo}`,
      headers: new Headers({ origin: 'https://repo.ing', ...address ? { 'cf-connecting-ip': address } : {} }),
      cookies: { get: name => cookie && name.includes('github') ? { value: cookie } : undefined }, json: async () => ({ action: 'claim' }) }, { params: Promise.resolve({ repo }) })
    return { status: response.status, body: await response.json(), response }
  }
  return { service, handoffs, github, session, call }
}

test('real PostgreSQL route: GET says whether packs may back a repository, its totals once a minute for a confirmed SOL market only, and whether the viewer holds the payout wallet', { skip: !url }, async t => {
  const pool = await connect()
  try {
    const { service, session, call } = await routeWorld(t, pool)
    service.state.totals = id => id === '1003' ? { repo_id: id, packs: 3, paid_micro: 3_000_000, claimed_micro: 1_000_000 } : { repo_id: id, packs: 0, paid_micro: 0, claimed_micro: 0 }
    const none = { packs: 0, paidMicro: '0', claimedMicro: '0', unclaimedMicro: '0' }
    const unknown = { packs: null, paidMicro: null, claimedMicro: null, unclaimedMicro: null }
    const base = { shareBps: 1000, reason: null, eligible: true, holder: false }
    const asked = id => service.requests.filter(request => request.pathname === `/builder-shares/${id}`).length
    const anonymous = await call('GET', '1003')
    assert.deepEqual([anonymous.status, anonymous.response.headers.get('cache-control')], [200, 'private, no-store'])
    assert.deepEqual(anonymous.body, { repoId: '1003', fullName: 'octo/repo1003', ...base, packs: 3, paidMicro: '3000000', claimedMicro: '1000000', unclaimedMicro: '2000000' })
    // A second look within the minute does not ask the credit service again.
    assert.equal(asked('1003'), 1)
    assert.equal((await call('GET', '1003', session({ scope: 'builders', repoId: null, permission: 'identity', githubUserId: '42' }))).body.eligible, true)
    assert.equal(asked('1003'), 1)

    assert.deepEqual((await call('GET', '1001')).body, { repoId: '1001', fullName: 'octo/hello', ...base, ...none })
    // The payout wallet holder cannot back their own repository with a pack, but sees its totals and that they hold it.
    const holder = await call('GET', '1001', session({ scope: 'builders', repoId: null, permission: 'identity' }))
    assert.deepEqual(holder.body, { repoId: '1001', fullName: 'octo/hello', shareBps: 1000, eligible: false, reason: holder.body.reason, holder: true, ...none })
    assert.match(holder.body.reason, /your own packs/)
    // A declined repository with a confirmed market still has shares to show.
    const declined = await call('GET', '1002')
    assert.deepEqual([declined.body.eligible, declined.body.fullName, declined.body.holder, declined.body.reason], [false, 'octo/repo1002', false, 'This repository’s maintainer opted out of repo.ing.'])
    assert.deepEqual([declined.body.packs, declined.body.unclaimedMicro, asked('1002')], [0, '0', 1])

    // No confirmed SOL market: the same answer with no amounts, and the credit service is not asked. 1004 never launched, 1005 is a
    // stock pair, 1007 is not indexed, 1008 has no market row, 9999 is unknown, the last two are not GitHub repository ids (Hugging Face).
    for (const [id, fullName, reason] of [['1004', 'octo/repo1004', /no market on repo\.ing/], ['1005', 'octo/repo1005', /stock pair/i], ['1007', 'octo/repo1007', /no market on repo\.ing/],
      ['1008', 'octo/repo1008', /no market on repo\.ing/], ['9999', null, /no market on repo\.ing/], ['4503599627370497', null, /GitHub repositories/], ['7000000000000000', null, /GitHub repositories/]]) {
      const answer = await call('GET', id)
      assert.deepEqual([answer.status, answer.body.repoId, answer.body.fullName, answer.body.eligible, answer.body.holder], [200, id, fullName, false, false], id)
      assert.match(answer.body.reason, reason, id)
      assert.deepEqual({ ...answer.body, repoId: undefined, fullName: undefined, reason: undefined, shareBps: undefined, eligible: undefined, holder: undefined },
        { ...unknown, repoId: undefined, fullName: undefined, reason: undefined, shareBps: undefined, eligible: undefined, holder: undefined }, id)
      assert.equal(asked(id), 0, `${id}: nothing asked`)
    }

    // The credit service cannot be reached: no amounts, the rest still answers, and the failure is not kept.
    service.state.down = true
    const down = await call('GET', '1006')
    assert.deepEqual([down.status, down.body.eligible, down.body.packs, down.body.paidMicro, down.body.claimedMicro, down.body.unclaimedMicro], [200, true, null, null, null, null])
    service.state.down = false
    assert.equal((await call('GET', '1006')).body.packs, 0)
    assert.deepEqual([...new Set(service.requests.map(request => request.pathname))].sort(),
      ['/builder-shares/1001', '/builder-shares/1002', '/builder-shares/1003', '/builder-shares/1006'], 'the credit service was asked about confirmed SOL markets only')
  } finally { await pool.end() }
})

test('real PostgreSQL route: GET is limited per address and in all, before any read', { skip: !url }, async t => {
  const pool = await connect()
  try {
    const { service, call } = await routeWorld(t, pool)
    const hits = async scope => (await pool.query('select hits from agent_request_limits where scope = $1', [scope])).rows[0]?.hits ?? 0
    const tooMany = { error: 'Too many requests. Try again in a minute.' }
    for (const address of ['203.0.113.7', undefined]) {
      for (let i = 0; i < 60; i++) assert.equal((await call('GET', '1003', undefined, address)).status, 200, `${address} ${i}`)
      const refused = await call('GET', '1003', undefined, address)
      assert.deepEqual([refused.status, refused.body, refused.response.headers.get('retry-after'), refused.response.headers.get('cache-control')], [429, tooMany, '60', 'private, no-store'])
    }
    // Once at most (an earlier test in this process may have left them cached), and not again for a refused request.
    assert.ok(service.requests.length <= 1, 'the totals were asked at most once')
    assert.equal(await hits('credits:shares:get:global'), 120, 'a refused request does not count in all')
    // Another address has its own allowance, until the allowance for all addresses is used.
    assert.equal((await call('GET', '1003', undefined, '203.0.113.8')).status, 200)
    await pool.query(`update agent_request_limits set hits = 240 where scope = 'credits:shares:get:global'`)
    const all = await call('GET', '1003', undefined, '203.0.113.9')
    assert.deepEqual([all.status, all.body], [429, tooMany])
  } finally { await pool.end() }
})

test('real PostgreSQL route: POST claims for the holder, sets the credit session cookie, and refuses anyone else', { skip: !url }, async t => {
  const pool = await connect()
  try {
    const { service, handoffs, github, session, call } = await routeWorld(t, pool)
    // Not the payout wallet's holder: GitHub says they are an admin, but nothing is signed in or asked.
    github.user = { id: 901, login: 'other' }
    const other = await call('POST', '1001', session({ repoId: '1001', permission: 'admin', githubUserId: '901', githubLogin: 'other' }))
    assert.deepEqual([other.status, other.body], [403, { error: 'Only the person who set this repository’s payout wallet can claim its pack shares.' }])
    assert.equal(other.response.headers.get('set-cookie'), null)
    assert.deepEqual([service.requests.length, await handoffs()], [0, 0])

    // The holder: a live admin check with GitHub, the claim, and the credit service's session in an encrypted cookie.
    github.user = { id: 900, login: 'holder' }
    const claimed = await call('POST', '1001', session({ repoId: '1001', permission: 'admin' }))
    assert.deepEqual([claimed.status, claimed.body], [200, { claimedMicro: '1000000', shares: 1 }])
    assert.equal(claimed.response.headers.get('cache-control'), 'private, no-store')
    const [token] = service.sessions.keys()
    const cookie = claimed.response.cookies.get(CREDITS_SESSION_COOKIE)
    assert.equal(openCreditsSession(cookie.value, HOLDER).token, token)
    assert.match(claimed.response.headers.get('set-cookie'), /HttpOnly/i)
    assert.match(claimed.response.headers.get('set-cookie'), /SameSite=strict/i)
    assert.ok(!JSON.stringify(claimed.body).includes(token), 'the session token never reaches the page')
    assert.equal(service.requests.at(-1).headers.authorization, `Bearer ${token}`)

    // The credit service refuses: its plain message and status come through, with no cookie.
    service.state.claim = { error: 'Not an admin session' }
    service.state.claimStatus = 403
    const refused = await call('POST', '1001', session({ repoId: '1001', permission: 'admin' }))
    assert.deepEqual([refused.status, refused.body, refused.response.headers.get('set-cookie')], [502, { error: 'Not an admin session' }, null])
  } finally { await pool.end() }
})
