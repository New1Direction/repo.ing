import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { LAUNCHABLE_STATES, LAUNCHABLE_TRENDS_SQL, OBSERVATION_LOOKBACK, readLaunchableTrends } from '../src/trend-launchable.mjs'
import { TREND_FRESH_MS } from '../src/trend-rules.mjs'
import { promotionExcludedRepoIds } from '../app/lib/promotion-exclusions.mjs'

// Real PostgreSQL with every committed migration: the one read behind "Launch a trending repo".
const url = process.env.TRENDING_TEST_DATABASE_URL
const HOUR = 3600000
const CONFIG = 'DbcConfig1111111111111111111111111111111111'

test('real PostgreSQL: one read lists fresh unlaunched trends and leaves out markets, opt-outs, do-not-promote, archived and stale repos', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/repoing_trending_test', 'Disposable trending test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query(`truncate trend_launches, trend_reviews, trend_signals, trend_observations, trend_candidates,
      repository_participation, maintainer_invites, markets, repositories cascade`)
    const now = Date.now(), at = hoursAgo => new Date(now - hoursAgo * HOUR)
    const candidate = (id, name, { state = 'detected', observed = 1, error = null, approvedConfig = null } = {}) => pool.query(
      `insert into trend_candidates(github_repo_id,full_name,description,state,observed_at,error,approved_config) values($1,$2,$3,$4,$5,$6,$7)`,
      [id, `acme/${name}`, `${name} fixture`, state, at(observed), error, approvedConfig])
    const observe = (id, name, stars, hoursAgo) => pool.query(`insert into trend_observations(github_repo_id,observed_at,evidence,evidence_hash) values($1,$2,$3,$4)`,
      [id, at(hoursAgo), JSON.stringify({ repo: { id: String(id), fullName: `acme/${name}`, stars, forks: 3, language: 'Rust',
        avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4` }, observedAt: at(hoursAgo).toISOString(), stars, forks: 3, releaseAt: null,
        activity: { complete: false }, sources: {} }), `hash-${id}-${hoursAgo}`])
    const growing = async (id, name, options) => { await candidate(id, name, options); await observe(id, name, 1120, 1); await observe(id, name, 1000, 5) }
    const flat = async (id, name, options) => { await candidate(id, name, options); await observe(id, name, 400, 1) }
    const signal = (id, source, url, expiresHours) => pool.query(`insert into trend_signals(github_repo_id,source,url,note,occurred_at,expires_at,operator)
      values($1,$2,$3,'fixture note',$4,$5,$6)`, [id, source, url, at(1), at(-expiresHours), source === 'manual' ? 'operator-42' : null])
    const repository = (id, name, archived = false) => pool.query(`insert into repositories(github_repo_id,owner,name,full_name,avatar_url,stars,forks,archived,github_updated_at)
      values($1,'acme',$2,$3,'https://avatars.githubusercontent.com/u/77?v=4',1,1,$4,now())`, [id, name, `acme/${name}`, archived])
    const market = (id, status) => pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature)
      values($1,$2,$3,$4,'launcher','creator','T','T',$5)`, [id, status, `mint${id}`, `pool${id}`, `sig${id}`])

    await growing(1001, 'rocket')
    await growing(1002, 'launched'); await repository(1002, 'launched'); await market(1002, 'confirmed')
    await growing(1003, 'retry'); await repository(1003, 'retry'); await market(1003, 'failed')
    await growing(1004, 'dup', { state: 'duplicate' })
    await growing(1005, 'no', { state: 'rejected' })
    await growing(1006, 'old'); await repository(1006, 'old', true)
    await growing(1007, 'optout'); await repository(1007, 'optout'); await market(1007, 'failed')
    await pool.query(`insert into repository_participation(github_repo_id,github_user_id,github_login,enabled,opted_in_at) values(1007,1,'maintainer',false,now())`)
    await growing(1008, 'quiet'); await repository(1008, 'quiet')
    await pool.query(`insert into maintainer_invites(github_repo_id,dismissed_at,operator_github_user_id) values(1008,now(),1)`)
    await growing(1009, 'stale', { observed: 7 })
    await growing(1010, 'broken', { error: 'REPO_NOT_VERIFIED' })
    await flat(1011, 'approved', { state: 'approved', approvedConfig: CONFIG }); await signal(1011, 'github_trending', 'https://github.com/trending', 5)
    await flat(1012, 'warming')
    await signal(1012, 'manual', 'https://x.com/someone/status/1', 24)
    await flat(1013, 'hot'); await signal(1013, 'github_trending', 'https://github.com/trending', 5)
    await signal(1013, 'manual', 'https://x.com/someone/status/2', 24)
    await flat(1014, 'expired'); await signal(1014, 'github_trending', 'https://github.com/trending', -1)
    await growing(1015, 'optin'); await repository(1015, 'optin'); await market(1015, 'failed')
    await pool.query(`insert into repository_participation(github_repo_id,github_user_id,github_login,enabled,opted_in_at) values(1015,1,'maintainer',true,now())`)

    // The read itself: bounded by state, refresh errors and freshness; facts for the rest; no manual evidence.
    const { rows } = await pool.query({ text: LAUNCHABLE_TRENDS_SQL,
      values: [new Date(now), new Date(now - TREND_FRESH_MS), OBSERVATION_LOOKBACK, [...LAUNCHABLE_STATES]] })
    const byId = Object.fromEntries(rows.map(row => [row.repoId, row]))
    assert.deepEqual(Object.keys(byId).sort(), ['1001', '1002', '1003', '1006', '1007', '1008', '1011', '1012', '1013', '1014', '1015'])
    assert.equal(byId['1002'].marketStatus, 'confirmed')
    assert.equal(byId['1003'].marketStatus, 'failed')
    assert.equal(byId['1006'].archived, true)
    assert.equal(byId['1007'].participationEnabled, false)
    assert.ok(byId['1008'].invitesDismissedAt instanceof Date)
    assert.equal(byId['1001'].observations.length, 2)
    assert.deepEqual(byId['1013'].signals.map(s => s.source), ['github_trending'])
    assert.deepEqual(byId['1012'].signals, [])
    assert.deepEqual(byId['1014'].signals, [])
    for (const row of rows) assert.doesNotMatch(JSON.stringify(row), /fixture note|operator-42/)

    let queries = 0
    const counted = { query: (...args) => { queries++; return pool.query(...args) } }
    const items = await readLaunchableTrends(counted, { now, config: CONFIG, discoveryEnabled: true })
    assert.equal(queries, 1, 'one query for the whole list')
    assert.deepEqual(items.map(item => item.repoId), ['1011', '1001', '1003', '1015', '1013'])
    const [approved, rocket] = items
    assert.equal(approved.launchHref, '/launch/1011?from=trend')
    assert.equal(rocket.launchHref, '/launch/1001')
    assert.deepEqual(rocket.starsGained, { delta: 120, hours: 4, perDay: 720 })
    assert.equal(rocket.avatarUrl, 'https://avatars.githubusercontent.com/u/1001?v=4')
    assert.equal(rocket.language, 'Rust')
    assert.equal(items.find(item => item.repoId === '1013').onGithubTrending, true)

    // The operator's do-not-promote list (PROMOTION_EXCLUDED_REPO_IDS) removes a repo the policy would otherwise list.
    const promoted = await readLaunchableTrends(pool, { now, config: CONFIG, discoveryEnabled: true,
      promotionExcluded: promotionExcludedRepoIds({ PROMOTION_EXCLUDED_REPO_IDS: '1001,1011' }) })
    assert.deepEqual(promoted.map(item => item.repoId), ['1003', '1015', '1013'])
  } finally {
    await pool.end()
  }
})
