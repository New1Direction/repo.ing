import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, randomUUID, sign } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { plainRecoveryJournal } from '../src/hooklab-plain-journal.mjs'
import { plainFixture, plainObservations } from './fixtures/hooklab-plain.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { encryptGithubSession, IDENTITY_SIGN_IN_PAGES } from '../app/lib/auth.mjs'
import { GET, POST } from '../app/api/hook-lab/production/account/route.js'

test('plain durable journal: ownership, concurrent retention, atomic audit, reload and outage preserve exact finalized evidence', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `plain_recovery_test_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    let journal = plainRecoveryJournal(pool)
    const f = plainFixture(), owner = '101', id = randomUUID()
    const [first, replay] = await Promise.all([journal.prepare(owner, id, f.plan), journal.prepare(owner, id, f.plan)])
    assert.deepEqual(first, replay)
    assert.equal(await journal.get('202', id), null)
    await assert.rejects(journal.prepare('202', id, f.plan), { status: 409 })
    await assert.rejects(journal.prepare(owner, randomUUID(), f.plan), /unique/)
    await assert.rejects(journal.prepare(owner, id, { ...f.plan, canSign: true }), { status: 409 })
    await pool.query("alter table hook_lab_plain_events add constraint fixture_failure check (kind <> 'signed')")
    await assert.rejects(journal.recordSigned(owner, id, f.signed), /fixture_failure/)
    assert.equal((await journal.get(owner, id)).signature, null)
    await pool.query('alter table hook_lab_plain_events drop constraint fixture_failure')
    const [signed, again] = await Promise.all([journal.recordSigned(owner, id, f.signed), journal.recordSigned(owner, id, f.signed)])
    assert.deepEqual(signed, again)
    assert.equal((await journal.get(owner, id)).status, 'unresolved')
    assert.equal((await journal.health()).unresolved, '1')
    const observations = plainObservations(f)
    const observed = await journal.observe(owner, id, observations, ['alpha', 'beta'])
    assert.equal(observed.status, 'receipt-state-matched')
    assert.deepEqual(observed.retained_receipt.observations, observations)
    await journal.observe(owner, id, [], ['alpha', 'beta'])
    await pool.end(); pool = new pg.Pool({ ...config, database }); journal = plainRecoveryJournal(pool)
    const recovered = await journal.get(owner, id)
    assert.equal(recovered.signed_transaction, f.signed)
    assert.equal(recovered.status, 'unresolved')
    assert.deepEqual(recovered.retained_receipt, observed.retained_receipt)
    assert.equal(recovered.canRetry, false); assert.equal(recovered.canSubmit, false)
    assert.equal((await journal.health()).unresolved, '0')
    assert.equal((await journal.health()).latest_unavailable, '1')
    assert.equal((await journal.pending())[0].signature, signed.signature)
    assert.deepEqual((await pool.query('select kind from hook_lab_plain_events order by id')).rows.map(r => r.kind), ['prepared', 'signed', 'observed', 'observed'])
    const conflict = plainObservations(f); conflict.forEach(o => { o.receipt.error = { InstructionError: [2, 'Custom'] } })
    const conflicted = await journal.observe(owner, id, conflict, ['alpha', 'beta'])
    assert.equal(conflicted.status, 'review-required')
    assert.deepEqual(conflicted.retained_receipt, observed.retained_receipt)
    assert.equal((await journal.health()).review_required, '1')
    assert.deepEqual(await journal.list('202'), [])
    assert.equal((await journal.list(owner))[0].receipt_retained, true)
    assert.ok(!('signed_transaction' in (await journal.list(owner))[0]))

    // Off-chain authorization uses ephemeral identities, never a transaction or real wallet.
    const auth = plainFixture(), authId = randomUUID(), context = { origin: 'https://repo.ing', sessionId: 'a'.repeat(48) }
    const proof = await journal.challenge(owner, authId, auth.plan, context)
    const signatureFor = (message, key = auth.creator) => sign(null, Buffer.from(message), createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(key.secretKey.subarray(0, 32))]),
      format: 'der', type: 'pkcs8',
    })).toString('base64')
    assert.match(proof.message, /^repo.ing Hook Lab preparation authorization v1\nOrigin: https:\/\/repo.ing\n/)
    assert.ok(proof.message.includes(`Operation: ${authId}`))
    assert.ok(proof.message.includes(`Message SHA256: ${auth.plan.review.messageSha256}`))
    const authorization = { ...context, nonce: proof.nonce, signature: signatureFor(proof.message) }
    await assert.rejects(journal.prepareAuthenticated('202', authId, auth.plan, authorization), { status: 409 })
    await assert.rejects(journal.prepareAuthenticated(owner, randomUUID(), auth.plan, authorization), { status: 409 })
    for (const change of [{ sessionId: 'b'.repeat(48) }, { origin: 'https://other.invalid' },
      { signature: signatureFor(proof.message, auth.payer) }, { signature: signatureFor(`${proof.message}\nchanged`) }]) {
      await assert.rejects(journal.prepareAuthenticated(owner, authId, auth.plan, { ...authorization, ...change }), { status: 409 })
    }
    await assert.rejects(journal.prepareAuthenticated(owner, authId, plainFixture().plan, authorization), { status: 409 })
    await pool.query("alter table hook_lab_plain_events add constraint proof_audit_failure check (kind <> 'prepared') not valid")
    await assert.rejects(journal.prepareAuthenticated(owner, authId, auth.plan, authorization), /proof_audit_failure/)
    assert.equal(await journal.get(owner, authId), null)
    assert.equal((await pool.query('select consumed_at from hook_lab_plain_challenges where nonce=$1', [proof.nonce])).rows[0].consumed_at, null)
    await pool.query('alter table hook_lab_plain_events drop constraint proof_audit_failure')
    const attempts = await Promise.allSettled([1, 2].map(() => journal.prepareAuthenticated(owner, authId, auth.plan, authorization)))
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter(r => r.status === 'rejected').length, 1)
    await assert.rejects(journal.prepareAuthenticated(owner, authId, auth.plan, authorization), { status: 409 })
    const expired = await journal.challenge(owner, authId, auth.plan, context)
    await pool.query("update hook_lab_plain_challenges set expires_at='1970-01-01T00:00:00Z' where nonce=$1", [expired.nonce])
    const expiredMessage = expired.message.replace(expired.expiresAt, '1970-01-01T00:00:00.000Z')
    await assert.rejects(journal.prepareAuthenticated(owner, authId, auth.plan,
      { ...context, nonce: expired.nonce, signature: signatureFor(expiredMessage) }), { status: 409 })
    assert.equal((await journal.get(owner, authId)).status, 'prepared', 'proof expiry never hides recovery')

    const keys = ['DATABASE_URL', 'GITHUB_APP_CLIENT_SECRET', 'HOOKLAB_PRODUCTION_ACCOUNT_ENABLED', 'HOOKLAB_PRODUCTION_DOSSIER_FILE']
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])), previousPool = globalThis.__hooklabAccountPool
    try {
      process.env.GITHUB_APP_CLIENT_SECRET = randomUUID()
      delete process.env.HOOKLAB_PRODUCTION_ACCOUNT_ENABLED
      delete process.env.HOOKLAB_PRODUCTION_DOSSIER_FILE
      delete process.env.DATABASE_URL
      const request = (user = owner, query = '') => {
        const req = new Request(`https://repo.ing/api/hook-lab/production/account${query}`)
        req.cookies = { get: () => user ? { value: encryptGithubSession({ scope: 'builders', permission: 'identity', repoId: null,
          githubUserId: user, githubLogin: 'synthetic-owner', accessToken: 'ghu_test_only', sessionId: 'c'.repeat(48), expiresAt: Date.now() + 60000 }) } : undefined }
        return req
      }
      assert.equal(IDENTITY_SIGN_IN_PAGES['hooklab-production'], '/coins/production')
      assert.equal((await GET(request(null))).status, 401)
      assert.equal((await (await GET(request())).json()).status, 'disabled', 'default gate does not require a DB')
      assert.equal(POST({ get body() { throw Error('must not read input') } }).status, 423)
      process.env.HOOKLAB_PRODUCTION_ACCOUNT_ENABLED = 'true'
      process.env.DATABASE_URL = 'postgres://unused-disposable-pool'
      globalThis.__hooklabAccountPool = pool
      const response = await GET(request())
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
      assert.equal(response.headers.get('Vary'), 'Cookie')
      const body = await response.json()
      assert.equal(body.status, 'read-only'); assert.equal(body.entries.length, 2)
      assert.equal(body.canSign, false); assert.equal(body.canSubmit, false)
      assert.equal(body.evidence.status, 'unavailable')
      assert.equal(body.entries.find(e => e.id === id).receiptRetained, true)
      assert.ok(!JSON.stringify(body).includes(f.signed), 'signed bytes must not escape account summary')
      assert.ok(!JSON.stringify(body).includes('ghu_'))
      assert.equal((await (await GET(request('202'))).json()).entries.length, 0)
      assert.equal((await GET(request('202', `?id=${id}`))).status, 404)
      assert.equal((await (await GET(request(owner, `?id=${id}`))).json()).entry.id, id)
      for (const query of ['?id=bad', `?id=${id}&id=${id}`, '?provider=untrusted']) assert.equal((await GET(request(owner, query))).status, 400)
      await pool.query('update agent_request_limits set hits=120 where scope=$1', [`hooklab-production-read:${owner}`])
      assert.equal((await GET(request())).status, 429)
      globalThis.__hooklabAccountPool = { query: async () => { throw Error('private database credential') } }
      const outage = await GET(request())
      assert.equal(outage.status, 503); assert.ok(!(await outage.text()).includes('private database credential'))
    } finally {
      globalThis.__hooklabAccountPool = previousPool
      for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
    }

    await pool.query(`update hook_lab_plain_recovery set plan=jsonb_set(plan,'{canSubmit}','true') where id=$1`, [id])
    await assert.rejects(journal.get(owner, id), { status: 409 })
  } finally {
    if (pool) await pool.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
