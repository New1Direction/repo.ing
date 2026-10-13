import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { BEACON_EVENTS, FUNNEL_EVENTS, FUNNEL_MAX_BYTES, FUNNEL_SOURCES, LOOKUP_OUTCOMES, VERIFY_OUTCOMES, claimHref, funnelEvent, funnelSource,
  funnelSummary, notAdminDetail, ownerQuery, parseFunnelBeacon, verificationMessage, verificationOutcome, withFunnelSource } from '../app/lib/claim-funnel.mjs'
import { createFunnelStore, recordFunnelEvent } from '../src/funnel-store.mjs'
import { ownerRepositories, ownerTotal } from '../app/lib/owner-lookup.mjs'
import { seal } from '../app/lib/auth.mjs'

// The maintainer claim funnel (docs/CLAIM_FUNNEL.md): attribution, verification outcomes, events, the owner lookup and the
// claim page states they drive.
process.env.GITHUB_APP_CLIENT_SECRET ||= 'claim-funnel-test-secret'

test('sources come from a fixed list and are added to claim links without disturbing them', () => {
  assert.equal(funnelSource('waiting'), 'waiting')
  for (const bad of ['', 'Waiting', 'toString', '__proto__', null, undefined, 1]) assert.equal(funnelSource(bad), null, String(bad))
  assert.equal(claimHref('42', 'x'), '/claim/42?src=x')
  assert.equal(claimHref('42', 'nope'), '/claim/42')
  assert.equal(withFunnelSource('/claim/42?error=x#tips', 'token'), '/claim/42?error=x&src=token#tips')
  assert.equal(withFunnelSource('https://repo.ing/claim/42', 'invite'), 'https://repo.ing/claim/42?src=invite')
})

test('every claim entry point carries its source', () => {
  assert.match(readFileSync('src/maintainer-invites.mjs', 'utf8'), /\/claim\/\$\{encodeURIComponent\(repoId\)\}\?src=invite/)
  assert.match(readFileSync('app/lib/owner-invitation.mjs', 'utf8'), /\?src=share/)
  assert.match(readFileSync('app/components/waiting-board.jsx', 'utf8'), /claimHref\(market\.repoId, 'waiting'\)/)
  assert.match(readFileSync('app/lib/waiting.mjs', 'utf8'), /claimPageUrl\(repoId, origin, 'x'\)/)
  assert.match(readFileSync('app/components/trust-panel.jsx', 'utf8'), /\/claim\/\$\{market\.repoId\}\?src=token/)
  assert.match(readFileSync('app/components/builder-dashboard.jsx', 'utf8'), /\/claim\/\$\{repo\.repoId\}\?src=builders/)
  // The source travels through GitHub sign-in in the sealed state and comes back to the claim page.
  assert.match(readFileSync('app/api/github/start/route.js', 'utf8'), /seal\(\{ repoId, mode, src, state:/)
})

test('GitHub verification outcomes are told apart: cancelled, not a current admin, failed, verified', () => {
  assert.deepEqual(verificationOutcome({ githubError: 'access_denied' }), { outcome: 'cancelled', error: 'github-cancelled', detail: null })
  assert.deepEqual(verificationOutcome({ githubError: 'redirect_uri_mismatch' }), { outcome: 'failed', error: 'verification-failed', detail: null })
  assert.deepEqual(verificationOutcome({ failed: true }), { outcome: 'failed', error: 'verification-failed', detail: null })
  assert.deepEqual(verificationOutcome({}), { outcome: 'failed', error: 'verification-failed', detail: null })
  assert.deepEqual(verificationOutcome({ result: { verified: true, permission: 'admin', githubLogin: 'octocat' } }), { outcome: 'verified', error: null, detail: null })
  assert.deepEqual(verificationOutcome({ result: { verified: false, permission: 'write', githubLogin: 'octocat' } }),
    { outcome: 'not-admin', error: 'not-admin', detail: { github: 'octocat', permission: 'write' } })
  assert.deepEqual(verificationOutcome({ result: { verified: false, permission: 'weird', githubLogin: '<script>' } }).detail, { github: null, permission: 'none' })
  // The dashboard only identifies the account; its sign-in has no repository permission to check.
  assert.equal(verificationOutcome({ result: { permission: 'identity' }, dashboard: true }).outcome, 'verified')
  assert.equal(verificationOutcome({ githubError: 'access_denied', dashboard: true }).outcome, 'cancelled')
  assert.deepEqual(notAdminDetail({ github: 'a-b', permission: 'maintain' }), { github: 'a-b', permission: 'maintain' })
  assert.deepEqual(notAdminDetail({ github: '-bad', permission: 'admin' }), { github: null, permission: 'none' })
  assert.match(verificationMessage('github-cancelled'), /cancelled, so nothing was verified/)
  assert.match(verificationMessage('verification-failed'), /usually temporary/)
  assert.match(verificationMessage('not-admin'), /not a current admin/)
  assert.equal(verificationMessage('other'), null)
})

test('beacons are strict: a fixed event, a known source and a repository id only on claim views', () => {
  assert.deepEqual(parseFunnelBeacon(JSON.stringify({ event: 'claim_view', source: 'x', repoId: '42' })), { event: 'claim_view', source: 'x', repoId: '42', outcome: null })
  assert.deepEqual(parseFunnelBeacon(JSON.stringify({ event: 'waiting_view', source: null, repoId: null })), { event: 'waiting_view', source: null, repoId: null, outcome: null })
  assert.deepEqual(parseFunnelBeacon(JSON.stringify({ event: 'builders_view' })), { event: 'builders_view', source: null, repoId: null, outcome: null })
  for (const bad of ['', 'null', '[]', '{', JSON.stringify({ event: 'verify_result', source: null, repoId: null }),
    JSON.stringify({ event: 'claim_view', source: null, repoId: null }), JSON.stringify({ event: 'claim_view', source: 'evil', repoId: '1' }),
    JSON.stringify({ event: 'claim_view', source: null, repoId: 42 }), JSON.stringify({ event: 'claim_view', source: null, repoId: '0' }),
    JSON.stringify({ event: 'waiting_view', repoId: '1' }), JSON.stringify({ event: 'waiting_view', url: 'https://x' }),
    JSON.stringify({ event: 'waiting_view', source: 'x'.repeat(FUNNEL_MAX_BYTES) })]) {
    assert.throws(() => parseFunnelBeacon(bad), /INVALID_FUNNEL/, bad)
  }
  assert.ok(BEACON_EVENTS.every(event => FUNNEL_EVENTS.includes(event)))
  assert.deepEqual(funnelEvent({ event: 'verify_result', source: 'bogus', repoId: '7', outcome: 'not-admin' }), { event: 'verify_result', source: null, repoId: '7', outcome: 'not-admin' })
  assert.deepEqual(funnelEvent({ event: 'owner_lookup', repoId: 'abc', outcome: 'maybe' }), { event: 'owner_lookup', source: null, repoId: null, outcome: null })
  assert.throws(() => funnelEvent({ event: 'page_view' }), /INVALID_FUNNEL/)
})

test('the summary totals events and outcomes, and converts views to verifications per source', () => {
  const summary = funnelSummary([
    { event: 'claim_view', outcome: null, source: 'waiting', day: 2, week: 5, month: 9 },
    { event: 'claim_view', outcome: null, source: null, day: 1, week: 1, month: 3 },
    { event: 'verify_start', outcome: null, source: 'waiting', day: 1, week: 2, month: 4 },
    { event: 'verify_result', outcome: 'verified', source: 'waiting', day: 0, week: 1, month: 2 },
    { event: 'verify_result', outcome: 'not-admin', source: 'waiting', day: 0, week: 1, month: 1 },
    { event: 'waiting_view', outcome: null, source: null, day: 7, week: 20, month: 40 },
  ])
  assert.equal(summary.count('claim_view'), 12)
  assert.equal(summary.count('claim_view', 'day'), 3)
  assert.equal(summary.count('verify_result:not-admin', 'week'), 1)
  assert.equal(summary.count('verify_result:cancelled'), 0)
  assert.deepEqual(summary.sources.map(row => [row.source, row.views.month, row.starts.month, row.verified.month]), [['waiting', 9, 4, 2], ['direct', 3, 0, 0]])
})

function fakePool(rows = []) {
  const queries = []
  return { queries, query: async (text, values) => { queries.push({ text, values }); return text.startsWith('delete') ? { rowCount: 3 } : { rows, rowCount: 1 } } }
}

test('the store writes one row per event, prunes at most hourly, and reads the ledger funnel split like /stats', async () => {
  let clock = 1_000
  const pool = fakePool([{ team: false, earning: 60, verified: 3, wallet: 2, paid: 1, waiting: 57, earnedLamports: '26250000000', paidLamports: '257000000', waitingLamports: '25960000000' }])
  const store = createFunnelStore(pool, { now: () => clock })
  await store.record({ event: 'claim_view', source: 'x', repoId: '42', outcome: null })
  await store.record({ event: 'verify_start', source: null, repoId: '42', outcome: null })
  assert.deepEqual(pool.queries.filter(q => q.text.startsWith('insert')).map(q => q.values), [['claim_view', 'x', '42', null], ['verify_start', null, '42', null]])
  assert.equal(pool.queries.filter(q => q.text.startsWith('delete')).length, 1)
  clock += 60 * 60 * 1000
  await store.record({ event: 'waiting_view' })
  assert.equal(pool.queries.filter(q => q.text.startsWith('delete')).length, 2)
  const ledger = await store.ledger()
  assert.equal(ledger.outside.waitingLamports, '25960000000')
  assert.equal(ledger.team.earning, 0)
  const ledgerQuery = pool.queries.at(-1)
  assert.match(ledgerQuery.text, /builder_fee_credits/); assert.match(ledgerQuery.text, /repo_claims where status = 'settled'/)
  assert.deepEqual(ledgerQuery.values, [['new1direction'], ['1388219884', '1250482335', '1269625283', '1266706783']])
  // Server events are best effort: no pool, a malformed event or a failed write never throws.
  assert.equal(await recordFunnelEvent(null, { event: 'verify_start' }), false)
  assert.equal(await recordFunnelEvent(fakePool(), { event: 'nope' }), false)
  assert.equal(await recordFunnelEvent({ query: async () => { throw Error('down') } }, { event: 'verify_start' }), false)
})

test('migration 0070 creates funnel_events with the same lists as the code, after every earlier migration, declared in the schema', () => {
  const sql = readFileSync('drizzle/0070_funnel_events.sql', 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "funnel_events"/)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP|ALTER TABLE)\b/i)
  for (const value of [...FUNNEL_EVENTS, ...Object.keys(FUNNEL_SOURCES), ...VERIFY_OUTCOMES, ...LOOKUP_OUTCOMES]) assert.ok(sql.includes(`'${value}'`), value)
  assert.doesNotMatch(sql, /"(login|github_login|github_user_id|wallet|ip|cookie|url)"/, 'nothing identifying is stored')
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const at = entries.findIndex(entry => entry.tag === '0070_funnel_events')
  assert.ok(at > 0 && entries[at].idx === entries[at - 1].idx + 1 && entries.slice(0, at).every(entry => entry.when < entries[at].when))
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  for (const name of ['funnel_events', 'funnel_events_created_at', 'funnel_events_event_check', 'funnel_events_source_check', 'funnel_events_outcome_check']) assert.ok(schema.includes(`'${name}'`), name)
})

test('the owner lookup lists one owner’s GitHub markets, case-insensitively, largest unclaimed first', () => {
  const market = (repoId, owner, remaining, extra = {}) => ({ repoId, owner, fullName: `${owner}/r${repoId}`, mint: `m${repoId}`, stars: 1, remaining, ...extra })
  const markets = [market('1', 'Acme', '5'), market('2', 'acme', '900', { wasVerified: true }), market('3', 'other', '1000'),
    market('4', 'ACME', '0', { beneficiaryWallet: 'W' }), market('5', 'acme', 'NaN'), market('9000000000000000', 'acme', '7')]
  const rows = ownerRepositories(markets, 'aCmE')
  assert.deepEqual(rows.map(row => [row.repoId, row.remaining, row.status]), [['2', '900', 'verified'], ['1', '5', 'waiting'], ['4', '0', 'wallet'], ['5', '0', 'waiting']])
  assert.equal(ownerTotal(rows), '905')
  assert.deepEqual(ownerRepositories(markets, ''), [])
  assert.equal(ownerQuery(' octocat '), 'octocat')
  for (const bad of ['', '-x', 'a/b', 'x'.repeat(40), null]) assert.equal(ownerQuery(bad), null, String(bad))
})

const { ClaimSteps } = await appModule('app/components/claim-steps.jsx')
const { OwnerLookup } = await appModule('app/components/owner-lookup.jsx')
const claimProps = { repoId: '42', mint: 'Mint1111', repoName: 'acme/widget', appAccess: 'installed', appSettingsUrl: 'https://github.com/apps/repo-ing',
  verifiedUser: null, beneficiaryWallet: null, claimable: '2500000000', usdEstimate: '$375.00', feeStatus: 'MATCH', payoutReady: true, settledClaim: null,
  review: null, summary: null, source: 'waiting' }

test('the claim page leads with the waiting amount and the next step, and keeps the source on Verify with GitHub', () => {
  const markup = html(h(ClaimSteps, { ...claimProps, errorCode: null }), { wallet: true })
  assert.match(markup, /<strong>2\.5 SOL<\/strong> is waiting for acme\/widget \(≈ \$375\.00\)\. Next: verify that you’re a current admin with GitHub/)
  assert.match(markup, /href="\/api\/github\/start\?repo=42&amp;mode=verify&amp;src=waiting"/)
  assert.match(markup, /Read-only GitHub metadata access/)
  assert.match(markup, /No seed phrase or private key, ever/)
  assert.match(markup, /does not imply your endorsement/)
  assert.match(markup, /Fees settle in SOL\. USD values are estimates\./, 'the existing disclosure stays')
})

test('a signed-in non-admin is told who they are signed in as and how to get an admin to claim', () => {
  const markup = html(h(ClaimSteps, { ...claimProps, errorCode: 'not-admin', notAdmin: { github: 'octocat', permission: 'write' } }), { wallet: true })
  assert.match(markup, /@octocat has write access to acme\/widget\./)
  assert.match(markup, /Only a current repository admin can claim builder fees/)
  assert.match(markup, /Copy claim link for an admin/)
  assert.match(markup, /href="https:\/\/github\.com\/logout"/)
  assert.doesNotMatch(markup, /could not be verified/)
})

test('cancelled and failed sign-ins say so in the GitHub step and offer to verify again', () => {
  const cancelled = html(h(ClaimSteps, { ...claimProps, errorCode: 'github-cancelled' }), { wallet: true })
  assert.match(cancelled, /GitHub sign-in was cancelled, so nothing was verified or shared/)
  assert.match(cancelled, /Verify with GitHub again/)
  const failed = html(h(ClaimSteps, { ...claimProps, errorCode: 'verification-failed' }), { wallet: true })
  assert.match(failed, /GitHub could not confirm access just now/)
  assert.doesNotMatch(failed, /cancelled/)
})

test('the owner lookup form posts to /builders and links each result to its claim page with the lookup source', () => {
  const empty = html(h(OwnerLookup, { owner: null, defaultOwner: 'octocat' }))
  assert.match(empty, /<form role="search" action="\/builders" method="get">/)
  assert.match(empty, /name="owner" value="octocat"/)
  const found = html(h(OwnerLookup, { owner: 'acme', rows: [{ repoId: '2', fullName: 'acme/r2', remaining: '1500000000', status: 'waiting' }] }))
  assert.match(found, /1\.5 SOL<\/strong> unclaimed across 1 repository owned by acme/)
  assert.match(found, /href="\/claim\/2\?src=lookup"/)
  assert.match(html(h(OwnerLookup, { owner: 'nobody', rows: [] })), /No repo\.ing markets found for <strong>nobody<\/strong>/)
})

const callback = await import('../app/api/github/callback/route.js')
function callbackRequest(query, state) {
  const url = `https://repo.ing/api/github/callback?${query}`
  return { url, nextUrl: new URL(url), cookies: { get: name => name === 'gitfun_oauth' ? { value: seal(state) } : undefined } }
}

test('the GitHub callback sends a cancelled sign-in back as cancelled, keeps the source, and records the outcome', async () => {
  const pool = fakePool()
  const saved = { url: process.env.DATABASE_URL, pool: globalThis.__gitfunPool, clientId: process.env.GITHUB_APP_CLIENT_ID, origin: process.env.APP_ORIGIN }
  process.env.DATABASE_URL = 'postgres://fake/funnel'; globalThis.__gitfunPool = pool; delete process.env.GITHUB_APP_CLIENT_ID; process.env.APP_ORIGIN = 'https://repo.ing'
  try {
    const expiresAt = Date.now() + 60_000
    const cancelled = await callback.GET(callbackRequest('error=access_denied&state=s', { repoId: '42', mode: 'verify', src: 'x', state: 's', expiresAt }))
    const back = new URL(cancelled.headers.get('location'))
    assert.equal(back.pathname, '/claim/42')
    assert.equal(back.searchParams.get('error'), 'github-cancelled')
    assert.equal(back.searchParams.get('src'), 'x')
    // Verification that cannot run (here: no GitHub App client id) is a failure, not a cancel.
    const failed = await callback.GET(callbackRequest('code=c&state=s', { repoId: '42', mode: 'verify', src: null, state: 's', expiresAt }))
    assert.equal(new URL(failed.headers.get('location')).searchParams.get('error'), 'verification-failed')
    const dashboard = await callback.GET(callbackRequest('error=access_denied&state=s', { mode: 'builders', state: 's', expiresAt }))
    assert.equal(new URL(dashboard.headers.get('location')).pathname + new URL(dashboard.headers.get('location')).search, '/builders?error=github-cancelled')
    // Other identity pages keep their single error code.
    const optOut = await callback.GET(callbackRequest('error=access_denied&state=s', { mode: 'opt-out', state: 's', expiresAt }))
    assert.equal(new URL(optOut.headers.get('location')).searchParams.get('error'), 'verification-failed')
    assert.deepEqual(pool.queries.filter(q => q.text.startsWith('insert')).map(q => q.values),
      [['verify_result', 'x', '42', 'cancelled'], ['verify_result', null, '42', 'failed'], ['builders_result', null, null, 'cancelled']])
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url
    globalThis.__gitfunPool = saved.pool
    if (saved.clientId !== undefined) process.env.GITHUB_APP_CLIENT_ID = saved.clientId
    if (saved.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved.origin
  }
})

// Real PostgreSQL with every committed migration (0070_funnel_events): the table's constraints, the summary and the ledger funnel.
const dbUrl = process.env.FUNNEL_TEST_DATABASE_URL
test('real PostgreSQL: funnel events keep to their lists, and the ledger funnel reads earned → verified → wallet → paid', { skip: !dbUrl }, async () => {
  const target = new URL(dbUrl)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_funnel_test', 'Disposable funnel test database required')
  const { default: pg } = await import('pg')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')
  const pool = new pg.Pool({ connectionString: dbUrl })
  const warn = console.warn
  console.warn = () => {}
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query('truncate funnel_events, repo_claims, repo_beneficiaries, repo_verifications, fee_events, markets, repositories restart identity cascade')
    // 1: outside, earned 5 SOL, nobody verified (waiting). 2: outside, verified, wallet, paid 1 of 3 SOL. 3: outside, nothing earned.
    // 4: a team repository (owner New1Direction) that earned 2 SOL and has a wallet. 5: outside, a failed launch (left out).
    const repos = [[1, 'acme', 'one'], [2, 'acme', 'two'], [3, 'zed', 'three'], [4, 'New1Direction', 'four'], [5, 'acme', 'five']]
    for (const [id, owner, name] of repos) {
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values($1,$2,$3,$4,1,0,false,now())`, [id, owner, name, `${owner}/${name}`])
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
        launch_slot,launch_finality,indexed_at,last_verified_at) values($1,$2,$3,$4,'w','w','T','T',$5,1,'finalized',now(),now())`,
      [id, id === 5 ? 'failed' : 'confirmed', `Mint${id}`, `Pool${id}`, `Sig${id}`])
    }
    const fee = (id, index, lamports) => pool.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot)
      values($1,$2,$3,$4,$5,$6,'So11111111111111111111111111111111111111112','dbc_creator_quote',10)`, [id, `Mint${id}`, `Pool${id}`, `Fee${id}-${index}`, index, lamports])
    await fee(1, 0, '5000000000'); await fee(2, 0, '3000000000'); await fee(4, 0, '2000000000'); await fee(5, 0, '9000000000')
    await pool.query(`insert into repo_verifications(github_repo_id,github_user_id,github_login,permission) values(2,7,'maintainer','admin')`)
    await pool.query(`insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values(2,7,'Wallet2'),(4,8,'Wallet4')`)
    await pool.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at)
      values(2,'Wallet2',1000000000,'sol','Paid2','settled',now()),(2,'Wallet2',500000000,'sol','Pending2','pending',null)`)
    const store = createFunnelStore(pool)
    const ledger = await store.ledger()
    assert.deepEqual(ledger.outside, { team: false, earning: 2, verified: 1, wallet: 1, paid: 1, earnedLamports: '8000000000', paidLamports: '1000000000',
      waitingLamports: '5000000000', waiting: 1 })
    assert.deepEqual(ledger.team, { team: true, earning: 1, verified: 0, wallet: 1, paid: 0, earnedLamports: '2000000000', paidLamports: '0',
      waitingLamports: '0', waiting: 0 })

    await store.record(parseFunnelBeacon(JSON.stringify({ event: 'claim_view', source: 'waiting', repoId: '1' })))
    await store.record(funnelEvent({ event: 'verify_start', source: 'waiting', repoId: '1' }))
    await store.record(funnelEvent({ event: 'verify_result', source: 'waiting', repoId: '1', outcome: 'not-admin' }))
    await pool.query(`insert into funnel_events(event,created_at) values('waiting_view', now() - interval '10 days'), ('waiting_view', now() - interval '200 days')`)
    const summary = funnelSummary(await store.summary())
    assert.equal(summary.count('claim_view', 'day'), 1)
    assert.equal(summary.count('verify_result:not-admin', 'week'), 1)
    assert.deepEqual([summary.count('waiting_view', 'week'), summary.count('waiting_view', 'month')], [0, 1], 'the 30-day window ignores older rows')
    assert.deepEqual(summary.sources.map(row => [row.source, row.views.month, row.starts.month, row.verified.month]), [['waiting', 1, 1, 0]])
    assert.equal(await store.prune(), 1, 'rows past 180 days are deleted')
    for (const bad of [`insert into funnel_events(event) values('page_view')`, `insert into funnel_events(event,source) values('claim_view','google')`,
      `insert into funnel_events(event,outcome) values('verify_result','maybe')`, `insert into funnel_events(event,repo_id) values('claim_view',0)`]) {
      await assert.rejects(pool.query(bad), /check constraint/, bad)
    }
  } finally {
    console.warn = warn
    await pool.end()
  }
})
