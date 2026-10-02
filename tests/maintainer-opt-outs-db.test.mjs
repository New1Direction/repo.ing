import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { activeDecision, activeDecisions, activeOptOutRepoIds, assertLaunchAllowed, createMaintainerDecisions, hasLiveMarket, OPT_OUT_ERROR } from '../src/maintainer-opt-outs.mjs'
import { createPromotionExclusions } from '../app/lib/promotion-exclusions.mjs'
import { createAgentLaunchService } from '../src/agent-launch.mjs'

// Real PostgreSQL with every committed migration (0041_maintainer_opt_outs): who may create and withdraw a maintainer
// decision, the one-active-decision rule, history, the table's constraints, and the readers built on it.
const url = process.env.MAINTAINER_OPT_OUTS_TEST_DATABASE_URL
const LIVE = '101', NO_MARKET = '202', OTHER = '303'

async function seed(pool) {
  await pool.query('truncate maintainer_opt_outs, markets, repositories restart identity cascade')
  await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
    values($1,'octo','live','octo/live',1,0,false,now())`, [LIVE])
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
    launch_slot,launch_finality,indexed_at,last_verified_at) values($1,'confirmed','MintLive','PoolLive','w','w','Live','LIVE','SigLive',1,'finalized',now(),now())`, [LIVE])
}

test('real PostgreSQL: maintainer decisions are created and withdrawn only by current admins', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_opt_outs_test', 'Disposable opt-out test database required')
  const pool = new pg.Pool({ connectionString: url })
  const warn = console.warn
  console.warn = () => {}
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await seed(pool)
    // verifyAdmin stands in for the fresh GitHub check: admins get their user id back, anyone else is refused.
    const checks = []
    const as = (githubUserId, admin = true) => createMaintainerDecisions({ pool, verifyAdmin: async request => {
      checks.push({ ...request, githubUserId })
      if (!admin) throw Error('Current GitHub admin permission required')
      return { githubUserId: BigInt(githubUserId), githubLogin: `user-${githubUserId}` }
    } })
    const maintainer = as('42'), coMaintainer = as('43'), stranger = as('99', false)
    assert.equal(await hasLiveMarket(pool, LIVE), true)
    assert.equal(await hasLiveMarket(pool, NO_MARKET), false)

    // A non-admin can neither create nor see anything recorded.
    await assert.rejects(stranger.create({ repoId: LIVE, kind: 'decline', note: 'not mine' }), error => error.status === 403)
    assert.equal((await pool.query('select count(*)::int as n from maintainer_opt_outs')).rows[0].n, 0)

    // An admin declines the live market, with a public note.
    const declined = await maintainer.create({ repoId: LIVE, kind: 'decline', note: '  We never wanted   a token. ' })
    assert.deepEqual({ ...declined, createdAt: typeof declined.createdAt }, { repoId: LIVE, kind: 'decline', note: 'We never wanted a token.', createdAt: 'string' })
    assert.deepEqual(await activeDecision(pool, LIVE), declined)
    assert.deepEqual(checks.at(-1), { githubRepoId: LIVE, live: true, githubUserId: '42' }, 'a live market uses the claim flow verifier')

    // Double create: refused while one is active, and the kind must match the market state.
    await assert.rejects(coMaintainer.create({ repoId: LIVE, kind: 'decline' }), error => error.status === 409 && /already declined/.test(error.message))
    await assert.rejects(maintainer.create({ repoId: LIVE, kind: 'opt_out' }), error => error.status === 409)
    assert.equal((await pool.query('select count(*)::int as n from maintainer_opt_outs where github_repo_id = $1', [LIVE])).rows[0].n, 1)

    // A repository repo.ing has never seen (no repositories row) can be opted out before anyone launches it.
    const optedOut = await maintainer.create({ repoId: NO_MARKET, kind: 'opt_out' })
    assert.deepEqual([optedOut.kind, optedOut.note], ['opt_out', null])
    assert.deepEqual(checks.at(-1), { githubRepoId: NO_MARKET, live: false, githubUserId: '42' }, 'no market: the no-market admin check')
    await assert.rejects(assertLaunchAllowed(pool, NO_MARKET), error => error.message === OPT_OUT_ERROR && error.status === 403)
    await assert.doesNotReject(assertLaunchAllowed(pool, OTHER))

    // Readers: the promotion union, the dashboard's per-repository map and the agent draft path.
    assert.deepEqual((await activeOptOutRepoIds(pool)).sort(), [LIVE, NO_MARKET])
    const excluded = createPromotionExclusions({ pool, env: { PROMOTION_EXCLUDED_REPO_IDS: '7' } })
    assert.deepEqual([...await excluded()].sort(), [LIVE, NO_MARKET, '7'])
    assert.deepEqual([...(await activeDecisions(pool, [LIVE, NO_MARKET, OTHER])).keys()].sort(), [LIVE, NO_MARKET])
    const agent = createAgentLaunchService({ pool, origin: 'https://repo.ing', secret: 'test-only-agent-draft-secret-at-least-32-bytes', config: '1'.repeat(32),
      discovery: false, allocation: false, candidates: async () => [], resolve: async () => ({ githubRepoId: BigInt(NO_MARKET), owner: 'octo', name: 'fresh',
        fullName: 'octo/fresh', description: null, avatarUrl: null, stars: 1, forks: 0, archived: false, githubUpdatedAt: new Date() }) })
    await assert.rejects(agent.createDraft({ repository: 'octo/fresh' }), new RegExp(OPT_OUT_ERROR))
    assert.equal((await pool.query('select count(*)::int as n from markets where github_repo_id = $1', [NO_MARKET])).rows[0].n, 0, 'nothing reserved')

    // Withdraw: a non-admin cannot; any current admin can, and who withdrew is recorded. Nothing is left to withdraw after.
    await assert.rejects(stranger.withdraw({ repoId: LIVE }), error => error.status === 403)
    assert.ok(await activeDecision(pool, LIVE))
    const withdrawn = await coMaintainer.withdraw({ repoId: LIVE })
    assert.equal(withdrawn.repoId, LIVE)
    assert.equal(await activeDecision(pool, LIVE), null)
    const { rows: [history] } = await pool.query(`select github_user_id::text as "by", withdrawn_by_github_user_id::text as "withdrawnBy",
      withdrawn_at is not null as withdrawn from maintainer_opt_outs where github_repo_id = $1`, [LIVE])
    assert.deepEqual(history, { by: '42', withdrawnBy: '43', withdrawn: true })
    await assert.rejects(maintainer.withdraw({ repoId: LIVE }), error => error.status === 409 && /nothing to withdraw/.test(error.message))
    assert.deepEqual([...await createPromotionExclusions({ pool, env: {} })()], [NO_MARKET], 'withdrawing restores promotion')

    // Declining again after a withdrawal starts a new active row; the old one stays as history.
    await maintainer.create({ repoId: LIVE, kind: 'decline' })
    assert.deepEqual((await pool.query(`select count(*)::int as total, count(*) filter (where withdrawn_at is null)::int as active
      from maintainer_opt_outs where github_repo_id = $1`, [LIVE])).rows[0], { total: 2, active: 1 })

    // The table enforces the same rules on its own.
    const insert = (values, columns = 'github_repo_id, kind, github_user_id, note') => pool.query(`insert into maintainer_opt_outs (${columns}) values (${values})`)
    await assert.rejects(insert(`${OTHER}, 'decline', 42, repeat('x', 281)`), /maintainer_opt_outs_note_check/)
    await assert.rejects(insert(`${OTHER}, 'delete', 42, null`), /maintainer_opt_outs_kind_check/)
    await assert.rejects(insert(`${OTHER}, 'decline', 0, null`), /maintainer_opt_outs_github_user_id_check/)
    await assert.rejects(insert(`${NO_MARKET}, 'opt_out', 42, null`), /maintainer_opt_outs_one_active/)
    await assert.rejects(insert(`${OTHER}, 'decline', 42, now()`, 'github_repo_id, kind, github_user_id, withdrawn_at'), /maintainer_opt_outs_withdrawn_check/)
  } finally {
    console.warn = warn
    await pool.end()
  }
})
