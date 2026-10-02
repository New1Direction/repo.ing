import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import pg from 'pg'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PASTED_ADDRESS_HOLD_MS, activateDuePayoutAddresses, createPayoutAddresses, readPayoutDestinations } from '../src/payout-address.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'
import { createClaim } from '../src/claim.mjs'
import { encryptGithubSession } from '../app/lib/auth.mjs'

// Real PostgreSQL with every committed migration (0048_pasted_payout_address): who may paste, replace, cancel and activate
// a payout address; the hold and the database guards behind it; the audit log; wallet signatures replacing a waiting
// address; and the claim path refusing a waiting recipient and rejecting reviews of a replaced one. The chain is
// scripted: a finalized account read for the paste check, and a sentinel for any read after recipient resolution. The
// last test drives the HTTP route with only GitHub's API and the Solana RPC stubbed.
const url = process.env.PAYOUT_ADDRESS_TEST_DATABASE_URL
const MAINTAINER = 501, CO_ADMIN = 502, OUTSIDER = 503
const wallet = () => Keypair.generate().publicKey.toBase58()
const last4 = address => address.slice(-4)
const freshWallet = { getAccountInfo: async () => null }
const code = expected => error => error?.code === expected

function requireDisposableDatabase() {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_payout_address_test',
    'Disposable payout address test database required')
}

const reset = pool => pool.query(`truncate payout_address_events, payout_address_requests, wallet_binding_challenges, repo_claims,
  repo_beneficiaries, repo_verifications, markets, repositories restart identity cascade`)

async function seed(pool, id, { config = Keypair.generate().publicKey, creator = Keypair.generate().publicKey, name = `repo-${id}` } = {}) {
  const mint = Keypair.generate().publicKey
  await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
    values ($1, 'octo', $2, $3, 1, 0, false, now())`, [id, name, `octo/${name}`])
  await pool.query(`insert into markets(github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol,
      launch_signature, launch_slot, launch_finality, indexed_at, last_verified_at)
    values ($1, 'confirmed', $2, $3, $4, $5, 'Repo', 'REPO', $6, 1, 'finalized', now(), now())`,
  [id, mint.toBase58(), deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58(), wallet(), creator.toBase58(), `Launch${id}`])
}

// verifyCurrentAuthority as the routes provide it: a fresh GitHub answer, recorded in repo_verifications when admin.
const authority = (pool, userId, { permission = 'admin', ageMs = 0, repoId = null, record = true } = {}) => async ({ githubRepoId }) => {
  if (permission === 'admin' && record) {
    await pool.query(`insert into repo_verifications(github_repo_id, github_user_id, github_login, permission) values ($1, $2, $3, 'admin')`,
      [String(githubRepoId), userId, `user${userId}`])
  }
  return { verified: permission === 'admin', permission, githubRepoId: repoId ?? githubRepoId, githubUserId: BigInt(userId),
    githubLogin: `user${userId}`, verifiedAt: new Date(Date.now() - ageMs) }
}

const requests = async (pool, repoId) => (await pool.query(`select id::text as id, wallet, status, requested_by_github_user_id::text as "by",
  resolved_by_github_user_id::text as "resolvedBy", resolution_reason as reason, requested_at as "requestedAt", active_at as "activeAt"
  from payout_address_requests where github_repo_id = $1 order by id`, [repoId])).rows
const events = async (pool, repoId) => (await pool.query(`select event, github_user_id::text as "user", wallet, previous_wallet as "previous"
  from payout_address_events where github_repo_id = $1 order by id`, [repoId])).rows
const binding = async (pool, repoId) => (await pool.query(`select wallet, method, payout_request_id::text as "requestId",
  github_user_id::text as "user", bound_at as "boundAt" from repo_beneficiaries where github_repo_id = $1`, [repoId])).rows[0] ?? null
const signatureBinding = (pool, repoId, address, daysAgo = 3) => pool.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet, bound_at)
  values ($1, $2, $3, now() - make_interval(days => $4))`, [repoId, MAINTAINER, address, daysAgo])

// Time travel for tests only. Requests are otherwise stamped by the database when stored and never change, so a superuser
// session with triggers off moves both timestamps back, keeping the 48-hour gap the check constraint still enforces.
async function withoutTriggers(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('set local session_replication_role = replica')
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally { client.release() }
}
const elapseHold = (pool, requestId) => withoutTriggers(pool, client => client.query(`update payout_address_requests
  set requested_at = requested_at - interval '49 hours', active_at = active_at - interval '49 hours' where id = $1`, [requestId]))
// A request stored 49 hours ago, recording the binding it would replace as the insert trigger does.
const insertDueRequest = (pool, repoId, address, userId = MAINTAINER) => withoutTriggers(pool, async client => (await client.query(`insert into
  payout_address_requests(github_repo_id, wallet, requested_by_github_user_id, requested_by_login, requested_at, active_at, replaces_bound_at)
  values ($1, $2, $3, 'maintainer', now() - interval '49 hours', now() - interval '1 hour',
    (select bound_at from repo_beneficiaries where github_repo_id = $1)) returning id::text as id`, [repoId, address, userId])).rows[0].id)

test('real PostgreSQL: pasting, replacing and cancelling a payout address take a current admin and leave an audit trail', { skip: !url }, async () => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  try {
    await reset(pool)
    await seed(pool, 9101)
    const service = createPayoutAddresses({ pool, connection: freshWallet })
    const first = wallet(), args = { githubRepoId: '9101', address: first, confirm: last4(first) }

    for (const verifyAuthority of [undefined, authority(pool, OUTSIDER, { permission: 'write' }), authority(pool, MAINTAINER, { ageMs: 61_000 }),
      authority(pool, MAINTAINER, { repoId: 9999n })]) {
      await assert.rejects(service.request({ ...args, verifyAuthority }), code('GITHUB_REQUIRED'))
    }
    await assert.rejects(service.request({ ...args, verifyAuthority: authority(pool, 777, { record: false }) }), /Recent GitHub admin verification required/,
      'an admin answer without its recorded verification is refused inside the transaction')
    await assert.rejects(service.request({ ...args, confirm: 'abcd', verifyAuthority: authority(pool, MAINTAINER) }), code('CONFIRMATION_MISMATCH'))
    assert.deepEqual(await requests(pool, 9101), [], 'refused requests store nothing')

    const pending = await service.request({ ...args, verifyAuthority: authority(pool, MAINTAINER) })
    assert.equal(Date.parse(pending.activeAt) - Date.parse(pending.requestedAt), PASTED_ADDRESS_HOLD_MS)
    assert.ok(Math.abs(Date.parse(pending.requestedAt) - Date.now()) < 60_000)
    assert.deepEqual(pending.notify, [String(MAINTAINER)])
    assert.equal(await binding(pool, 9101), null, 'a pasted address is never bound right away')
    let destination = (await readPayoutDestinations(pool, ['9101'])).get('9101')
    assert.deepEqual([destination.active, destination.pending.wallet, destination.pending.requestedByLogin], [null, first, `user${MAINTAINER}`])
    assert.deepEqual(await activateDuePayoutAddresses(pool), [], 'nothing is due during the hold')
    await assert.rejects(service.request({ ...args, verifyAuthority: authority(pool, MAINTAINER) }), code('ALREADY_PENDING'))

    // A co-admin pastes another address: the waiting one is superseded and the hold starts again.
    const second = wallet()
    const replaced = await service.request({ githubRepoId: '9101', address: second, confirm: last4(second), verifyAuthority: authority(pool, CO_ADMIN) })
    assert.deepEqual(replaced.notify.sort(), [String(MAINTAINER), String(CO_ADMIN)].sort(), 'the replaced request’s author is told too')
    assert.equal(replaced.replacedWallet, first)
    let rows = await requests(pool, 9101)
    assert.deepEqual(rows.map(r => [r.wallet, r.status, r.resolvedBy]), [[first, 'superseded', String(CO_ADMIN)], [second, 'pending', null]])

    await assert.rejects(service.cancel({ githubRepoId: '9101', requestId: replaced.id, verifyAuthority: authority(pool, OUTSIDER, { permission: 'write' }) }),
      code('GITHUB_REQUIRED'))
    await assert.rejects(service.cancel({ githubRepoId: '9101', requestId: pending.id, verifyAuthority: authority(pool, MAINTAINER) }), code('NOT_PENDING'))
    await assert.rejects(service.cancel({ githubRepoId: '9101', requestId: 'x', verifyAuthority: authority(pool, MAINTAINER) }), code('INVALID_REQUEST'))
    // Any current admin may cancel, not only its author.
    const cancelled = await service.cancel({ githubRepoId: '9101', requestId: replaced.id, verifyAuthority: authority(pool, MAINTAINER) })
    assert.deepEqual([cancelled.wallet, cancelled.cancelledBy], [second, `user${MAINTAINER}`])
    await assert.rejects(service.cancel({ githubRepoId: '9101', requestId: replaced.id, verifyAuthority: authority(pool, MAINTAINER) }), code('NOT_PENDING'))
    rows = await requests(pool, 9101)
    assert.deepEqual(rows.map(r => [r.status, r.resolvedBy]), [['superseded', String(CO_ADMIN)], ['cancelled', String(MAINTAINER)]])
    assert.match(rows[1].reason, /Cancelled by user501/)
    assert.deepEqual((await events(pool, 9101)).map(e => [e.event, e.user, e.wallet]), [
      ['requested', String(MAINTAINER), first], ['superseded', String(CO_ADMIN), first], ['requested', String(CO_ADMIN), second], ['cancelled', String(MAINTAINER), second]])
    destination = (await readPayoutDestinations(pool, ['9101'])).get('9101')
    assert.deepEqual(destination, { active: null, pending: null })

    // At most five requests per repository per hour (each can email its builders).
    for (let i = 0; i < 3; i++) {
      const next = wallet()
      await service.request({ githubRepoId: '9101', address: next, confirm: last4(next), verifyAuthority: authority(pool, MAINTAINER) })
    }
    const sixth = wallet()
    let asked = 0
    await assert.rejects(service.request({ githubRepoId: '9101', address: sixth, confirm: last4(sixth),
      verifyAuthority: async input => { asked++; return authority(pool, MAINTAINER)(input) } }),
    error => error.code === 'RATE_LIMITED' && error.status === 429)
    assert.equal(asked, 0, 'refused before any GitHub (or Solana) call')
  } finally { await pool.end() }
})

test('real PostgreSQL: a pasted address activates only after its hold, and the database refuses every shortcut', { skip: !url }, async () => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  try {
    await reset(pool)
    await seed(pool, 9201); await seed(pool, 9202)
    const service = createPayoutAddresses({ pool, connection: freshWallet })
    const signed = wallet(), pasted = wallet()
    await signatureBinding(pool, 9201, signed)
    const before = await binding(pool, 9201)
    await assert.rejects(service.request({ githubRepoId: '9201', address: signed, confirm: last4(signed), verifyAuthority: authority(pool, MAINTAINER) }),
      code('ALREADY_ACTIVE'))
    const request = await service.request({ githubRepoId: '9201', address: pasted, confirm: last4(pasted), verifyAuthority: authority(pool, MAINTAINER) })
    assert.equal(request.previousWallet, signed)
    assert.deepEqual(await activateDuePayoutAddresses(pool), [])
    assert.equal((await binding(pool, 9201)).wallet, signed, 'the previous binding keeps receiving claims during the hold')

    // No writer can shorten the hold, activate early, or bind a pasted address that is not an activated request. An
    // insert is stamped by the database: a backdated or short hold is not kept, and nothing is stored already resolved.
    await assert.rejects(pool.query('update payout_address_requests set active_at = now() where id = $1', [request.id]), /terms cannot change/)
    await assert.rejects(pool.query("update payout_address_requests set status = 'activated', resolved_at = now() where id = $1", [request.id]), /hold has not ended/)
    const { rows: [stamped] } = await pool.query(`insert into payout_address_requests(github_repo_id, wallet, requested_by_github_user_id,
        requested_by_login, requested_at, active_at) values (9202, $1, $2, 'x', now() - interval '49 hours', now() - interval '1 hour')
      returning id, extract(epoch from (active_at - requested_at))::int as hold, requested_at >= now() as fresh`, [wallet(), MAINTAINER])
    assert.deepEqual([stamped.hold, stamped.fresh], [48 * 3600, true], 'the hold runs 48 hours from the moment the row is stored')
    await pool.query("update payout_address_requests set status = 'cancelled', resolved_at = now(), resolution_reason = 'test' where id = $1", [stamped.id])
    await assert.rejects(pool.query(`insert into payout_address_requests(github_repo_id, wallet, requested_by_github_user_id, requested_by_login,
      active_at, status, resolved_at) values (9202, $1, $2, 'x', now(), 'activated', now())`, [wallet(), MAINTAINER]), /starts pending/)
    await assert.rejects(withoutTriggers(pool, client => client.query(`insert into payout_address_requests(github_repo_id, wallet,
      requested_by_github_user_id, requested_by_login, active_at) values (9202, $1, $2, 'x', now() + interval '47 hours 59 minutes')`,
    [wallet(), MAINTAINER])), /payout_address_requests_hold_check/, 'the check holds even with triggers off')
    await assert.rejects(pool.query(`update repo_beneficiaries set wallet = $1, method = 'pasted', payout_request_id = $2, github_user_id = $3
      where github_repo_id = 9201`, [pasted, request.id, MAINTAINER]), /Pasted payout address is not active/)
    await assert.rejects(pool.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet, method, payout_request_id)
      values (9202, $1, $2, 'pasted', $3)`, [MAINTAINER, pasted, request.id]), /Pasted payout address is not active/)
    await assert.rejects(pool.query('update repo_beneficiaries set payout_request_id = $1 where github_repo_id = 9201', [request.id]),
      /repo_beneficiaries_method_check/)
    await insertDueRequest(pool, 9202, pasted)
    await assert.rejects(insertDueRequest(pool, 9202, wallet()), /payout_address_requests_one_pending/, 'one waiting address per repository')
    assert.equal((await binding(pool, 9201)).wallet, signed)

    await elapseHold(pool, request.id)
    const [activation] = await activateDuePayoutAddresses(pool, { repoIds: ['9201'] })
    assert.deepEqual(activation, { status: 'activated', repoId: '9201', requestId: request.id, wallet: pasted, previousWallet: signed })
    const after = await binding(pool, 9201)
    assert.deepEqual([after.wallet, after.method, after.requestId, after.user], [pasted, 'pasted', request.id, String(MAINTAINER)])
    assert.ok(after.boundAt > before.boundAt, 'a new binding time, so reviews sealed for the previous recipient stop matching')
    assert.deepEqual((await requests(pool, 9201)).map(r => r.status), ['activated'])
    assert.deepEqual((await events(pool, 9201)).map(e => [e.event, e.user, e.wallet, e.previous]),
      [['requested', String(MAINTAINER), pasted, signed], ['activated', null, pasted, signed]])
    const destination = (await readPayoutDestinations(pool, ['9201'])).get('9201')
    assert.deepEqual([destination.active.wallet, destination.active.method, destination.pending], [pasted, 'pasted', null])

    // Once active it can no longer be cancelled; the request and the audit log never change again.
    await assert.rejects(service.cancel({ githubRepoId: '9201', requestId: request.id, verifyAuthority: authority(pool, CO_ADMIN) }), code('NOT_PENDING'))
    await assert.rejects(pool.query("update payout_address_requests set status = 'cancelled', resolution_reason = 'x' where id = $1", [request.id]),
      /resolved payout address request cannot change/)
    await assert.rejects(pool.query("update payout_address_events set wallet = 'x'"), /append-only/)
    await assert.rejects(pool.query('delete from payout_address_events'), /append-only/)

    // The due request inserted above for 9202 waits while another session holds the repository's lock (a claim in flight).
    const holder = await pool.connect()
    try {
      await holder.query('select pg_advisory_lock(9202)')
      assert.deepEqual((await activateDuePayoutAddresses(pool, { repoIds: ['9202'] })).map(r => r.status), ['busy'])
      assert.equal(await binding(pool, 9202), null)
    } finally { await holder.query('select pg_advisory_unlock(9202)'); holder.release() }
    assert.deepEqual((await activateDuePayoutAddresses(pool)).map(r => [r.status, r.repoId]), [['activated', '9202']])
    assert.equal((await binding(pool, 9202)).wallet, pasted)
  } finally { await pool.end() }
})

test('real PostgreSQL: a binding changed after a request wins over it, whatever the clocks say; a busy lock refuses promptly', { skip: !url }, async () => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  try {
    await reset(pool)
    await seed(pool, 9601)
    const service = createPayoutAddresses({ pool, connection: freshWallet })
    const original = wallet(), pasted = wallet(), other = wallet()
    await signatureBinding(pool, 9601, original)
    const change = await service.request({ githubRepoId: '9601', address: pasted, confirm: last4(pasted), verifyAuthority: authority(pool, MAINTAINER) })
    // Once the hold has passed, another writer replaces the binding without superseding the request, stamping bound_at
    // from a clock running behind the database's: the new bound_at is EARLIER than the request's requested_at. A
    // timestamp comparison would let the pasted address activate over it; the recorded replaces_bound_at does not.
    await elapseHold(pool, change.id)
    await pool.query(`update repo_beneficiaries set wallet = $1, bound_at = (select requested_at - interval '1 minute'
      from payout_address_requests where id = $2) where github_repo_id = 9601`, [other, change.id])
    assert.deepEqual((await activateDuePayoutAddresses(pool, { repoIds: ['9601'] })).map(r => r.status), ['superseded'])
    assert.equal((await binding(pool, 9601)).wallet, other)
    assert.deepEqual((await requests(pool, 9601)).map(r => [r.status, r.reason]), [['superseded', 'A newer payout binding replaced it']])
    assert.deepEqual((await events(pool, 9601)).map(e => [e.event, e.user]), [['requested', String(MAINTAINER)], ['superseded', String(MAINTAINER)]])

    // A claim (or another change) holding the repository's lock makes a paste fail fast, saving nothing.
    const holder = await pool.connect()
    try {
      await holder.query('select pg_advisory_lock(9601)')
      const quick = createPayoutAddresses({ pool, connection: freshWallet, lockTimeoutMs: 200 })
      const next = wallet()
      await assert.rejects(quick.request({ githubRepoId: '9601', address: next, confirm: last4(next), verifyAuthority: authority(pool, MAINTAINER) }),
        error => error.code === 'BUSY' && error.status === 409)
    } finally { await holder.query('select pg_advisory_unlock(9601)'); holder.release() }
    assert.equal((await requests(pool, 9601)).length, 1, 'nothing was saved')
  } finally { await pool.end() }
})

test('real PostgreSQL: a wallet signature replaces a waiting pasted address at once; batch setup treats a due one as set', { skip: !url }, async () => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  try {
    await reset(pool)
    for (const id of [9301, 9302, 9303]) await seed(pool, id)
    const service = createPayoutAddresses({ pool, connection: freshWallet }), binder = createWalletBinding({ pool })
    const key = generateKeyPairSync('ed25519')
    const signer = new PublicKey(key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()
    const signMessage = message => sign(null, Buffer.from(message, 'utf8'), key.privateKey)

    const pasted = wallet()
    const request = await service.request({ githubRepoId: '9301', address: pasted, confirm: last4(pasted), verifyAuthority: authority(pool, CO_ADMIN) })
    await pool.query(`insert into repo_verifications(github_repo_id, github_user_id, github_login, permission) values (9301, $1, 'maintainer', 'admin')`, [MAINTAINER])
    const challenge = await binder.requestChallenge({ githubRepoId: 9301n, githubUserId: BigInt(MAINTAINER), wallet: signer })
    const bound = await binder.bindWallet({ githubRepoId: 9301n, githubUserId: BigInt(MAINTAINER), wallet: signer, nonce: challenge.nonce,
      signature: signMessage(challenge.message) })
    assert.deepEqual([bound.wallet, bound.method, bound.payoutRequestId], [signer, 'signature', null], 'signature bindings stay instant')
    const [row] = await requests(pool, 9301)
    assert.deepEqual([row.id, row.status, row.resolvedBy, row.reason], [request.id, 'superseded', String(MAINTAINER), 'Replaced by a wallet-signature binding'])
    assert.deepEqual((await events(pool, 9301)).map(e => [e.event, e.user]), [['requested', String(CO_ADMIN)], ['superseded', String(MAINTAINER)]])
    assert.deepEqual(await activateDuePayoutAddresses(pool), [])

    // Batch wallet setup only binds repositories without a payout address: a due pasted one counts as set.
    for (const id of [9302, 9303]) {
      await pool.query(`insert into repo_verifications(github_repo_id, github_user_id, github_login, permission) values ($1, $2, 'maintainer', 'admin')`, [id, MAINTAINER])
    }
    await insertDueRequest(pool, 9303, wallet())
    const batch = await binder.requestBatchChallenge({ githubRepoIds: ['9302', '9303'], githubUserId: String(MAINTAINER), wallet: signer })
    await assert.rejects(binder.bindBatch({ nonces: batch.nonces, githubUserId: String(MAINTAINER), wallet: signer, signature: signMessage(batch.message) }),
      /Payout wallet changed/)
    assert.equal(await binding(pool, 9302), null, 'nothing is bound from a refused batch')
    assert.deepEqual((await requests(pool, 9303)).map(r => r.status), ['pending'])

    // A waiting (not yet due) pasted address does not block a batch signature; the signature replaces it.
    const waiting = wallet()
    await service.request({ githubRepoId: '9302', address: waiting, confirm: last4(waiting), verifyAuthority: authority(pool, MAINTAINER) })
    const only = await binder.requestBatchChallenge({ githubRepoIds: ['9302'], githubUserId: String(MAINTAINER), wallet: signer })
    assert.deepEqual(await binder.bindBatch({ nonces: only.nonces, githubUserId: String(MAINTAINER), wallet: signer, signature: signMessage(only.message) }),
      { count: 1, wallet: signer })
    assert.deepEqual((await requests(pool, 9302)).map(r => [r.status, r.reason]), [['superseded', 'Replaced by a wallet-signature binding']])
    assert.equal((await binding(pool, 9302)).method, 'signature')
  } finally { await pool.end() }
})

test('real PostgreSQL: batch paste is all or nothing, checks every repository, and refuses addresses that are not wallets', { skip: !url }, async () => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  try {
    await reset(pool)
    for (const id of [9401, 9402, 9403]) await seed(pool, id)
    await signatureBinding(pool, 9403, wallet())
    const service = createPayoutAddresses({ pool, connection: freshWallet })
    const address = wallet(), args = { address, confirm: last4(address) }
    const count = async () => (await pool.query('select count(*)::int as n from payout_address_requests')).rows[0].n

    await assert.rejects(service.requestBatch({ ...args, githubRepoIds: ['9401', '9402', '9403'], verifyAuthority: authority(pool, MAINTAINER) }), code('ALREADY_SET'))
    const partial = async input => input.githubRepoId === 9402n ? authority(pool, MAINTAINER, { permission: 'write' })(input) : authority(pool, MAINTAINER)(input)
    await assert.rejects(service.requestBatch({ ...args, githubRepoIds: ['9401', '9402'], verifyAuthority: partial }), code('GITHUB_REQUIRED'))
    await assert.rejects(service.requestBatch({ ...args, githubRepoIds: ['9401', '9401'], verifyAuthority: authority(pool, MAINTAINER) }), code('INVALID_REPOSITORIES'))
    await assert.rejects(service.requestBatch({ ...args, githubRepoIds: Array.from({ length: 101 }, (_, i) => String(10_000 + i)),
      verifyAuthority: authority(pool, MAINTAINER) }), code('INVALID_REPOSITORIES'))
    assert.equal(await count(), 0, 'a refused batch stores nothing')

    // The account check: one finalized read, refused (never guessed) when it fails or finds a token account.
    const unreachable = createPayoutAddresses({ pool, connection: { getAccountInfo: async () => { throw new Error('fetch failed') } } })
    await assert.rejects(unreachable.requestBatch({ ...args, githubRepoIds: ['9401'], verifyAuthority: authority(pool, MAINTAINER) }),
      error => error.code === 'ACCOUNT_UNAVAILABLE' && error.status === 503)
    const tokenAccount = createPayoutAddresses({ pool, connection: { getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, executable: false, data: Buffer.alloc(165), lamports: 2_039_280 }) } })
    await assert.rejects(tokenAccount.request({ ...args, githubRepoId: '9401', verifyAuthority: authority(pool, MAINTAINER) }), code('NOT_A_WALLET'))
    assert.equal(await count(), 0)

    const result = await service.requestBatch({ ...args, githubRepoIds: ['9402', '9401'], verifyAuthority: authority(pool, MAINTAINER) })
    assert.deepEqual([result.count, result.wallet, result.notify], [2, address, [String(MAINTAINER)]])
    for (const id of [9401, 9402]) {
      const [row] = await requests(pool, id)
      assert.deepEqual([row.wallet, row.status], [address, 'pending'])
      assert.equal(row.activeAt - row.requestedAt, PASTED_ADDRESS_HOLD_MS)
      assert.equal(await binding(pool, id), null)
    }
  } finally { await pool.end() }
})

test('real PostgreSQL: the claim path never pays a waiting address and rejects reviews of a replaced recipient', { skip: !url }, async () => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  try {
    await reset(pool)
    const config = Keypair.generate().publicKey, creator = Keypair.generate()
    await seed(pool, 9501, { config, creator: creator.publicKey }); await seed(pool, 9502, { config, creator: creator.publicKey })
    // The payout signer is funded; every other chain read throws this sentinel, so reaching it means the recipient and
    // review checks passed and a real claim would go on to build its transaction.
    const sentinel = 'CHAIN_READ_REACHED'
    const connection = new Connection('http://127.0.0.1:9', 'confirmed')
    connection.getBalance = async () => 1_000_000_000
    connection._rpcRequest = async () => { throw new Error(sentinel) }
    const claim = createClaim({ pool, connection, config, creator, githubVerifier: { verifyCurrentAuthority: async ({ githubRepoId }) =>
      ({ verified: true, permission: 'admin', githubRepoId, githubUserId: BigInt(MAINTAINER), verifiedAt: new Date() }) } })
    const service = createPayoutAddresses({ pool, connection: freshWallet })
    const review = (repoId, current) => ({ purpose: 'builder-claim-review', repoId: String(repoId), wallet: current.wallet,
      boundAt: new Date(current.boundAt).toISOString(), paid: '0', amount: '1000', expiresAt: Date.now() + 600_000 })
    const request = repoId => ({ githubRepoId: repoId, githubAuthorization: { session: true } })

    // Only a waiting pasted address: refused with the time claims open, before any chain read.
    const onlyWaiting = wallet()
    const waiting = await service.request({ githubRepoId: '9502', address: onlyWaiting, confirm: last4(onlyWaiting), verifyAuthority: authority(pool, MAINTAINER) })
    await assert.rejects(claim.claim(request(9502)), new RegExp(`48-hour hold until ${waiting.activeAt.replace(/[.]/g, '\\.')}`))

    // A signature binding with a pasted change waiting: claims still go to the signature-bound wallet.
    const signed = wallet(), pasted = wallet()
    await signatureBinding(pool, 9501, signed)
    const current = await binding(pool, 9501)
    const change = await service.request({ githubRepoId: '9501', address: pasted, confirm: last4(pasted), verifyAuthority: authority(pool, MAINTAINER) })
    await assert.rejects(claim.claim({ ...request(9501), review: review(9501, current) }), new RegExp(sentinel), 'the current binding passes')
    await assert.rejects(claim.claim({ ...request(9501), review: review(9501, { wallet: pasted, boundAt: change.requestedAt }) }),
      /Payout details changed/, 'a review naming the waiting address is refused')
    assert.equal((await binding(pool, 9501)).wallet, signed)

    // The hold passes. The claim activates the address under its own lock; the review of the old recipient now fails
    // before any chain read, and only a review of the new binding proceeds.
    await elapseHold(pool, change.id)
    await assert.rejects(claim.claim({ ...request(9501), review: review(9501, current) }), /Payout details changed/)
    const activated = await binding(pool, 9501)
    assert.deepEqual([activated.wallet, activated.method, activated.requestId], [pasted, 'pasted', change.id])
    assert.deepEqual((await events(pool, 9501)).map(e => e.event), ['requested', 'activated'])
    await assert.rejects(claim.claim({ ...request(9501), review: review(9501, activated) }), new RegExp(sentinel))
    assert.equal((await pool.query('select count(*)::int as n from repo_claims')).rows[0].n, 0, 'no payout intent was created in any case')
    const other = await pool.connect()
    try {
      const { rows: [lock] } = await other.query('select pg_try_advisory_lock(9501) as free')
      assert.equal(lock.free, true, 'the claim released the repository lock')
      await other.query('select pg_advisory_unlock(9501)')
    } finally { other.release() }
  } finally { await pool.end() }
})

test('real PostgreSQL route: claim and Builders sessions paste and cancel only with a current GitHub admin check', { skip: !url }, async t => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  const saved = { env: { ...process.env }, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  t.after(async () => {
    for (const key of ['DATABASE_URL', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN', 'SOLANA_RPC_URL', 'BUILDER_REMINDERS_ENABLED']) {
      if (saved.env[key] === undefined) delete process.env[key]; else process.env[key] = saved.env[key]
    }
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
    await pool.end()
  })
  await reset(pool)
  await seed(pool, 77, { name: 'widget' })
  const rpc = 'http://127.0.0.1:8999'
  Object.assign(process.env, { DATABASE_URL: url, GITHUB_APP_CLIENT_ID: 'Iv1.test-only', GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex'),
    APP_ORIGIN: 'https://repo.ing', SOLANA_RPC_URL: rpc })
  delete process.env.BUILDER_REMINDERS_ENABLED
  globalThis.__gitfunPool = pool
  let permission = 'admin', rpcDown = false
  const calls = []
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input))
    if (target.origin === rpc) {
      const body = JSON.parse(init.body)
      calls.push(`rpc:${body.method}`)
      if (rpcDown) return new Response('unavailable', { status: 503 })
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: null } })
    }
    calls.push(target.pathname)
    const body = target.pathname === '/user' ? { id: 583231, login: 'octocat' }
      : target.pathname === '/repositories/77' ? { id: 77, owner: { login: 'octo' }, name: 'widget', private: false, archived: false }
        : target.pathname === '/repos/octo/widget/collaborators/octocat/permission' ? { permission, user: { id: 583231 } } : null
    return body ? Response.json(body) : new Response('not found', { status: 404 })
  }
  const { POST } = await import('../app/api/payout-address/route.js')
  const session = extra => encryptGithubSession({ githubUserId: '583231', githubLogin: 'octocat', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000, ...extra })
  const builders = session({ scope: 'builders', repoId: null, permission: 'identity' }), claimSession = session({ repoId: '77', permission: 'admin' })
  const post = async (cookie, body, origin = 'https://repo.ing') => {
    const response = await POST({ url: 'https://repo.ing/api/payout-address', headers: new Headers({ origin }),
      cookies: { get: () => cookie ? { value: cookie } : undefined }, json: async () => body })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    return { status: response.status, body: await response.json() }
  }
  const address = wallet(), paste = { action: 'paste', repoId: '77', address, confirm: last4(address) }

  let result = await post(claimSession, paste, 'https://evil.example')
  assert.equal(result.status, 403); assert.match(result.body.error, /Open the claim page/)
  result = await post(null, paste)
  assert.equal(result.status, 403); assert.match(result.body.error, /Connect GitHub/)
  result = await post(session({ repoId: '78', permission: 'admin' }), paste)
  assert.equal(result.status, 403); assert.equal(calls.length, 0, 'a claim session for another repository never reaches GitHub or Solana')
  result = await post(claimSession, { ...paste, action: 'paste-batch', repoIds: ['77'] })
  assert.equal(result.status, 403, 'only a Builders session may batch')
  result = await post(claimSession, { ...paste, address: 'not-an-address' })
  assert.equal(result.status, 400); assert.match(result.body.error, /not a Solana address/)
  permission = 'write'
  result = await post(claimSession, paste)
  assert.equal(result.status, 403); assert.match(result.body.error, /Current GitHub admin/)
  assert.ok(calls.includes('/repos/octo/widget/collaborators/octocat/permission'))
  assert.equal(calls.filter(c => c.startsWith('rpc:')).length, 0, 'no chain read before GitHub authority')
  permission = 'admin'
  rpcDown = true
  result = await post(claimSession, paste)
  assert.equal(result.status, 503); assert.match(result.body.error, /Solana could not be reached/)
  rpcDown = false
  assert.deepEqual(await requests(pool, 77), [])

  result = await post(claimSession, paste)
  assert.equal(result.status, 200)
  assert.equal(result.body.pending.wallet, address)
  assert.equal(Date.parse(result.body.pending.activeAt) - Date.parse(result.body.pending.requestedAt), PASTED_ADDRESS_HOLD_MS)
  assert.ok(calls.includes('rpc:getAccountInfo'))
  assert.equal(await binding(pool, 77), null)

  result = await post(builders, { action: 'cancel', repoId: '77', requestId: result.body.pending.id })
  assert.deepEqual(result, { status: 200, body: { cancelled: true, requestId: (await requests(pool, 77))[0].id } })
  result = await post(builders, { action: 'paste-batch', repoIds: ['77'], address, confirm: last4(address) })
  assert.equal(result.status, 200); assert.equal(result.body.count, 1)
  assert.deepEqual((await requests(pool, 77)).map(r => r.status), ['cancelled', 'pending'])
  assert.deepEqual((await events(pool, 77)).map(e => [e.event, e.user]), [['requested', '583231'], ['cancelled', '583231'], ['requested', '583231']])
})
