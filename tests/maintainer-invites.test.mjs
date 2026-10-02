import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { INVITE_SNOOZE_MS, ISSUE_URL_LIMIT, createMaintainerInvites, inviteText, inviteThreshold, issueUrl, selectInviteCandidates } from '../src/maintainer-invites.mjs'

const SOL = 1000000000n, now = Date.parse('2026-09-29T00:00:00Z')
const row = (repoId, available, extra = {}) => ({ repoId, available: String(available), claimed: false, invitedAt: null, dismissedAt: null, ...extra })

test('threshold defaults to 0.5 SOL and reads MAINTAINER_INVITE_MIN_SOL', () => {
  assert.equal(inviteThreshold({}), SOL / 2n)
  assert.equal(inviteThreshold({ MAINTAINER_INVITE_MIN_SOL: '1.25' }), 1250000000n)
  assert.equal(inviteThreshold({ MAINTAINER_INVITE_MIN_SOL: 'lots' }), SOL / 2n)
  assert.equal(inviteThreshold({ MAINTAINER_INVITE_MIN_SOL: '0' }), SOL / 2n)
})

test('selection applies the threshold, sorts by unclaimed fees and caps at 10', () => {
  const picked = selectInviteCandidates([row('1', SOL / 2n - 1n), row('2', SOL / 2n), row('3', 3n * SOL), row('4', null, { available: null })], { threshold: SOL / 2n, now })
  assert.deepEqual(picked.map(r => r.repoId), ['3', '2'])
  const many = Array.from({ length: 15 }, (_, i) => row(String(i + 1), SOL + BigInt(i)))
  assert.equal(selectInviteCandidates(many, { now }).length, 10)
  assert.equal(selectInviteCandidates(many, { now })[0].repoId, '15')
})

test('claimed, dismissed and recently invited repositories are excluded', () => {
  const rows = [row('1', SOL, { claimed: true }), row('2', SOL, { dismissedAt: new Date(now - 400 * 86400000) }),
    row('3', SOL, { invitedAt: new Date(now - INVITE_SNOOZE_MS + 60000) }), row('4', SOL, { invitedAt: new Date(now - INVITE_SNOOZE_MS - 1) }), row('5', SOL)]
  assert.deepEqual(selectInviteCandidates(rows, { now }).map(r => r.repoId).sort(), ['4', '5'])
})

test('invite text links the claim page, states optional participation and how to opt out', () => {
  const text = inviteText({ repoId: '42', fullName: 'acme/widget', available: '1500000000', origin: 'https://repo.ing' })
  assert.match(text, /https:\/\/repo\.ing\/claim\/42/)
  assert.match(text, /1\.5 SOL/)
  assert.match(text, /optional/)
  assert.match(text, /not an endorsement/)
  assert.match(text, /rather not be contacted/)
  assert.doesNotMatch(text, /price|moon|pump|\$REPOING|buy/i)
})

test('issue URL is encoded, targets issues/new, and stays under the length limit', () => {
  const url = issueUrl({ fullName: 'acme/widget', title: 'Fees & more?', body: 'a b\n#1 ✓' })
  assert.equal(url, 'https://github.com/acme/widget/issues/new?title=Fees%20%26%20more%3F&body=a%20b%0A%231%20%E2%9C%93')
  const long = issueUrl({ fullName: 'acme/widget', title: 'T', body: '✓é😀&'.repeat(5000) })
  assert.ok(long.length <= ISSUE_URL_LIMIT)
  assert.doesNotThrow(() => decodeURIComponent(new URL(long).searchParams.get('body')))
  assert.match(new URL(long).searchParams.get('body'), /…$/)
  assert.throws(() => issueUrl({ fullName: 'evil.com/../x', title: 't', body: 'b' }))
  assert.throws(() => issueUrl({ fullName: 'a/b?x=1', title: 't', body: 'b' }))
})

const url = process.env.TEST_DATABASE_URL
const local = url && new URL(url).hostname === '127.0.0.1' && new URL(url).port === '55441'
test('real PostgreSQL: migration, exclusions, snooze, permanent dismissal and issues-disabled repos', { skip: !local }, async () => {
  const db = new pg.Pool({ connectionString: url, max: 1 }), schema = `maintainer_invites_${randomBytes(5).toString('hex')}`
  const client = await db.connect()
  try {
    await client.query(`create schema ${schema};set search_path to ${schema}`)
    await client.query(`create table repositories(github_repo_id bigint primary key,full_name text not null,stars integer not null,archived boolean not null default false);
      create table markets(github_repo_id bigint primary key references repositories,status text,indexed_at timestamptz,launch_finality text);
      create table builder_fee_credits(github_repo_id bigint,amount_base_units bigint);
      create table repo_claims(github_repo_id bigint,amount_base_units bigint,status text);
      create table repo_beneficiaries(github_repo_id bigint primary key);
      create table repository_participation(github_repo_id bigint primary key);
      create table maintainer_opt_outs(github_repo_id bigint,withdrawn_at timestamptz)`)
    await client.query(await readFile(new URL('../drizzle/0027_maintainer_invites.sql', import.meta.url), 'utf8'))
    const ids = [1, 2, 3, 4, 5, 6, 7, 8]
    await client.query(`insert into repositories select id,'o/r'||id,id*10,id=8 from unnest($1::bigint[]) id`, [ids])
    await client.query(`insert into markets select id,'confirmed',now(),'finalized' from unnest($1::bigint[]) id`, [ids])
    await client.query(`insert into builder_fee_credits select id, id*1000000000 from unnest($1::bigint[]) id`, [ids])
    await client.query(`insert into builder_fee_credits values(1,-800000000);insert into repo_beneficiaries values(3);
      insert into repo_claims values(4,100,'pending');insert into repository_participation values(5)`)
    const pool = { query: (...args) => client.query(...args) }
    let clock = now
    const invites = createMaintainerInvites({ pool, now: () => clock, env: {}, origin: 'https://repo.ing',
      verifiedFee: async repoId => repoId === '7' ? null : String(BigInt(repoId) * SOL - (repoId === '1' ? 800000000n : 0n)),
      repoMeta: async repoId => ({ fullName: `o/r${repoId}`, stars: 99, hasIssues: repoId !== '6' }) })
    let { candidates } = await invites.list()
    // 1: below threshold (0.2 SOL); 3,4,5 claimed/engaged; 7 unverified; 8 archived.
    assert.deepEqual(candidates.map(c => c.repoId), ['6', '2'])
    assert.equal(candidates[0].hasIssues, false); assert.equal(candidates[0].issueUrl, null)
    assert.match(candidates[1].issueUrl, /^https:\/\/github\.com\/o\/r2\/issues\/new\?title=/)
    const operator = { githubUserId: '77', githubLogin: 'op' }
    await invites.record({ repoId: '2', action: 'invited', operator })
    await invites.record({ repoId: '6', action: 'dismissed', operator })
    assert.deepEqual((await invites.list()).candidates, [])
    const { rows: [stored] } = await client.query(`select operator_github_user_id::text as op, operator_login, invited_at from maintainer_invites where github_repo_id=2`)
    assert.deepEqual([stored.op, stored.operator_login, stored.invited_at.getTime()], ['77', 'op', now])
    clock = now + INVITE_SNOOZE_MS + 1000
    candidates = (await invites.list()).candidates
    assert.deepEqual(candidates.map(c => c.repoId), ['2'])
    // A maintainer who declined the market is never invited; a withdrawn decline does not count.
    await client.query('insert into maintainer_opt_outs values(2,now())')
    assert.deepEqual((await invites.list()).candidates.map(c => c.repoId), ['2'])
    await client.query('insert into maintainer_opt_outs values(2,null)')
    assert.deepEqual((await invites.list()).candidates, [])
    await client.query('delete from maintainer_opt_outs')
    await assert.rejects(invites.record({ repoId: '6', action: 'invited', operator }), /dismissed/)
    await assert.rejects(invites.record({ repoId: '999', action: 'invited', operator }), /no market/)
    await assert.rejects(invites.record({ repoId: '2', action: 'post', operator }), /Unsupported/)
    await assert.rejects(client.query('insert into maintainer_invites(github_repo_id,operator_github_user_id) values(2,1) on conflict do nothing') .then(() => client.query('insert into maintainer_invites(github_repo_id,operator_github_user_id) values(1,1)')), /maintainer_invites_state_check/)
  } finally { await client.query(`drop schema ${schema} cascade`); client.release(); await db.end() }
})
