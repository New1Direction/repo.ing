import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair } from '@solana/web3.js'
import { BUILDER_SHARE_BPS, builderShareTarget } from '../src/builder-pack-shares.mjs'
import { createCreditsPacks } from '../src/credits-packs.mjs'
import { packBuilderTicket } from '../src/credits-tickets.mjs'
import { redeemHandoff } from '../src/repo-inference-handoff.mjs'

// Real PostgreSQL with every committed migration (0069_pack_builder_shares): which repositories a pack may be opened for (one
// read), the table's own rule for the repository and rate, and the pack quote for a repository against a stand-in credit service
// that checks the signed ticket like the credit ledger and replays a quote under the same Idempotency-Key.
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
// 1004 never launched; 1005 is a stock pair; 1006 was declined and the decision withdrawn; 1007 has a market that is not indexed.
async function seed(pool) {
  await pool.query('truncate maintainer_opt_outs, repo_beneficiaries, markets, repositories restart identity cascade')
  for (const id of [1001, 1002, 1003, 1004, 1005, 1006, 1007]) {
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
