import test from 'node:test'
import assert from 'node:assert/strict'
import { forkOf, readLaunchedRepositoryById, readRepositoryStars, resolvePublicRepository, RepositoryResolutionError } from '../src/github.mjs'
import { checkLaunchLineage, createLineageBackfill, launchLineage, LineageError, recordLineage, rootCommit } from '../src/repo-lineage.mjs'
import { launchFailure } from '../src/launch-failure.mjs'
import { selectLaunchableTrends } from '../src/trend-launchable.mjs'

const sha = n => n.toString(16).padStart(40, '0')
// A request that never answers until its signal aborts. AbortSignal.timeout does not keep the event loop alive (a real request's
// socket does), so the wait holds it open.
const hangingUntilAborted = async (url, { signal }) => {
  const keepAlive = setInterval(() => {}, 1000)
  try { return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) } finally { clearInterval(keepAlive) }
}
const json = (body, { status = 200, link = null } = {}) => ({ status, ok: status >= 200 && status < 300,
  headers: { get: name => name.toLowerCase() === 'link' ? link : null }, json: async () => body })

test('GitHub fork facts: parent and source for a fork, nothing for a repository that is not one', () => {
  assert.deepEqual(forkOf({ fork: true, parent: { id: 5, full_name: 'orig/app' }, source: { id: 2, full_name: 'root/app' } }),
    { parent: { id: '5', fullName: 'orig/app' }, source: { id: '2', fullName: 'root/app' } })
  assert.equal(forkOf({ fork: false, parent: { id: 5, full_name: 'orig/app' } }), null)
  assert.equal(forkOf({}), null)
  assert.deepEqual(forkOf({ fork: true, parent: { id: 'x', full_name: 'orig/app' } }), { parent: null, source: null })
})

test('a resolved repository carries fork facts only when it is a fork', async () => {
  const repo = (extra = {}) => ({ id: 77, full_name: 'me/app', name: 'app', owner: { login: 'me' }, private: false, archived: false,
    updated_at: '2026-10-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z', ...extra })
  const plain = await resolvePublicRepository('https://github.com/me/app', async () => json(repo()))
  assert.equal('fork' in plain, false)
  const fork = await resolvePublicRepository('https://github.com/me/app', async () => json(repo({ fork: true, parent: { id: 5, full_name: 'orig/app' } })))
  assert.deepEqual(fork.fork, { parent: { id: '5', fullName: 'orig/app' }, source: null })
})

test('the first commit is the last page of a one-per-page commit list', async () => {
  const urls = []
  const fetchImpl = async url => {
    urls.push(url)
    return url.endsWith('per_page=1') ? json([{ sha: sha(999) }], { link: '<https://api.github.com/repositories/77/commits?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/77/commits?per_page=1&page=4210>; rel="last"' })
      : json([{ sha: sha(1) }])
  }
  assert.equal(await rootCommit('me/app', fetchImpl), sha(1))
  assert.deepEqual(urls, ['https://api.github.com/repos/me/app/commits?per_page=1', 'https://api.github.com/repositories/77/commits?per_page=1&page=4210'])
  // One commit in all: no Link header, the first page is the root.
  assert.equal(await rootCommit('me/app', async () => json([{ sha: sha(7) }])), sha(7))
  // An empty repository, an unreadable list, and a name that is not one.
  assert.equal(await rootCommit('me/app', async () => json({ message: 'Git Repository is empty.' }, { status: 409 })), null)
  await assert.rejects(rootCommit('me/app', async () => json({}, { status: 502 })), /GITHUB_COMMITS_HTTP_502/)
  await assert.rejects(rootCommit('me/app?x', async () => json([])), /LINEAGE_REPOSITORY_INVALID/)
  // A list longer than one page must name GitHub's own last page: anything else would leave only the newest commit.
  await assert.rejects(rootCommit('me/app', async () => json([{ sha: sha(3) }], { link: '<https://evil.example/x>; rel="last"' })), /GITHUB_COMMITS_NO_LAST_PAGE/)
  await assert.rejects(rootCommit('me/app', async () => json([{ sha: sha(3) }], { link: '<https://api.github.com/repositories/77/commits?per_page=1&page=2>; rel="next"' })), /GITHUB_COMMITS_NO_LAST_PAGE/)
  // An overall deadline stops a list GitHub is slow to answer.
  const started = Date.now()
  await assert.rejects(rootCommit('me/app', hangingUntilAborted, AbortSignal.timeout(50)), error => error.name === 'TimeoutError')
  assert.ok(Date.now() - started < 5000)
})

test('a launched repository read again: gone (404, private) is null, archived still counts, anything else is retried', async () => {
  const body = (extra = {}) => ({ id: 77, full_name: 'me/app', name: 'app', owner: { login: 'me' }, private: false, archived: false,
    updated_at: '2026-10-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z', ...extra })
  assert.equal(await readLaunchedRepositoryById('77', async () => json({}, { status: 404 })), null)
  assert.equal(await readLaunchedRepositoryById('77', async () => json(body({ private: true }))), null)
  const archived = await readLaunchedRepositoryById('77', async () => json(body({ archived: true })))
  assert.deepEqual([archived.archived, archived.fullName], [true, 'me/app'])
  for (const status of [403, 429, 500, 502, 503]) {
    await assert.rejects(readLaunchedRepositoryById('77', async () => json({}, { status })), error =>
      !(error instanceof RepositoryResolutionError) && error.message === `GITHUB_REPOSITORY_HTTP_${status}`)
  }
  await assert.rejects(readLaunchedRepositoryById('77', async () => json(body({ id: 78 }))), RepositoryResolutionError)
})

test('star unlocks read a repository\'s stars by its id: no usable count or a gone repository is null, never 0', async () => {
  const urls = []
  const read = (body, options) => readRepositoryStars('77', async url => { urls.push(url); return json(body, options) })
  assert.equal(await read({ id: 77, stargazers_count: 1234, archived: true }), 1234)
  assert.equal(urls[0], 'https://api.github.com/repositories/77')
  for (const count of [undefined, null, -1, 1.5, '12', 2 ** 32]) assert.equal(await read({ id: 77, stargazers_count: count }), null)
  assert.equal(await read({}, { status: 404 }), null)
  assert.equal(await read({ id: 77, private: true, stargazers_count: 5 }), null)
  await assert.rejects(read({}, { status: 403 }), { message: 'GITHUB_REPOSITORY_HTTP_403' })
  await assert.rejects(read({ id: 78, stargazers_count: 5 }), RepositoryResolutionError)
  await assert.rejects(readRepositoryStars('0x1'), RepositoryResolutionError)
})

test('advisory checks use what was stored and write nothing; launch prepare always reads the first commit again', async () => {
  const pool = (stored) => {
    const statements = []
    return { statements, query: async (sql, params) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '))
      if (/from repositories where github_repo_id = \$1/.test(sql)) return { rows: stored ? [stored] : [] }
      return { rows: [] }
    } }
  }
  const repo = { githubRepoId: 30n, fullName: 'fresh/app', owner: 'fresh', githubCreatedAt: new Date('2026-03-01') }
  const reads = []
  const readRoot = async (name, fetchImpl, signal) => { reads.push(signal ? 'deadline' : 'full'); return sha(30) }
  // Checked before: the stored first commit, no GitHub read, no write.
  const known = pool({ root: sha(30), checkedAt: new Date() })
  assert.deepEqual(await checkLaunchLineage({ pool: known, repo, readRoot, advisory: true }), { forkOf: null })
  assert.deepEqual(reads, []); assert.equal(known.statements.some(sql => sql.startsWith('update')), false)
  // Never checked: read within the deadline, then stored once.
  const unknown = pool(null)
  await checkLaunchLineage({ pool: unknown, repo, readRoot, advisory: true })
  assert.deepEqual(reads, ['deadline']); assert.equal(unknown.statements.filter(sql => sql.startsWith('update')).length, 1)
  // Launch prepare: always a fresh read, even when one is stored.
  await checkLaunchLineage({ pool: known, repo, readRoot })
  assert.deepEqual(reads, ['deadline', 'full'])
  // A GitHub too slow for the advisory deadline skips the copy check (fail open), logged, and is not marked checked.
  const logs = [], slow = pool(null)
  const verdict = await checkLaunchLineage({ pool: slow, repo, advisory: true, deadlineMs: 30, log: (...args) => logs.push(args),
    readRoot: (name, fetchImpl, signal) => hangingUntilAborted(null, { signal }) })
  assert.deepEqual(verdict, { forkOf: null })
  assert.deepEqual(logs, [['lineage_root_unavailable', { repo: 'fresh/app', code: 'TIMEOUT' }]])
})

test('a refusal is final in the launch review, with its own code', () => {
  assert.equal(new LineageError('x', {}).name, 'LineageError')
  const failure = launchFailure(new LineageError('This repository is a fork of orig/app, which already has a market on repo.ing.', {}), 'prepare')
  assert.deepEqual(failure, { error: 'This repository is a fork of orig/app, which already has a market on repo.ing.', canRetry: false, code: 'COPY_OF_LAUNCHED_REPOSITORY' })
})

test('a trending fork shows the repository it was forked from', () => {
  const now = Date.parse('2026-09-30T12:00:00Z'), iso = t => new Date(t).toISOString()
  const observation = (stars, hours, repo = {}) => JSON.stringify({ repo: { id: '101', fullName: 'acme/rocket', stars, forks: 10, ...repo },
    observedAt: iso(now - hours * 3600000), stars, forks: 10, releaseAt: null, activity: { complete: false }, sources: {} })
  const row = repo => ({ repoId: '101', fullName: 'acme/rocket', description: null, state: 'detected', observedAt: new Date(now - 3600000), error: null,
    approvedConfig: null, storedAvatarUrl: null, archived: null, marketStatus: null, participationEnabled: null, invitesDismissedAt: null,
    observations: [observation(1120, 1, repo), observation(1000, 5)], signals: [] })
  assert.equal(selectLaunchableTrends([row({ forkOf: 'orig/rocket' })], { now })[0].forkOf, 'orig/rocket')
  assert.equal('forkOf' in selectLaunchableTrends([row({})], { now })[0], false)
  assert.equal('forkOf' in selectLaunchableTrends([row({ forkOf: 'not a name' })], { now })[0], false)
})

test('real PostgreSQL: forks of launched repositories and copies of older launched repositories are refused, nothing else', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const { default: pg } = await import('pg')
  const url = new URL(process.env.CHART_TEST_DATABASE_URL)
  assert.equal(url.port, '55441', 'Use the dedicated chart test DB, never the production tunnel')
  const db = new pg.Client({ connectionString: url.href }); await db.connect()
  try {
    await db.query('begin')
    await db.query(`create temporary table repositories(github_repo_id bigint primary key, owner text, name text, full_name text, description text,
      avatar_url text, stars integer, forks integer, archived boolean, github_updated_at timestamptz, github_created_at timestamptz,
      synced_at timestamptz default now(), source text default 'github', root_commit varchar(40), fork_parent_id bigint,
      fork_parent_full_name text, lineage_checked_at timestamptz)`)
    await db.query('create temporary table markets(id serial, github_repo_id bigint, status text, mint text, indexed_at timestamptz, launch_finality text)')
    const repo = (id, fullName, created, root = null) => db.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived,
      github_updated_at, github_created_at, root_commit) values($1,$2,$3,$4,0,0,false,now(),$5,$6)`, [id, fullName.split('/')[0], fullName.split('/')[1], fullName, created, root])
    // A live market by default: confirmed, indexed and finalized.
    const market = (id, status = 'confirmed', live = status === 'confirmed') => db.query(`insert into markets(github_repo_id, status, mint, indexed_at, launch_finality)
      values($1,$2,$3,$4,$5)`, [id, status, `mint${id}`, live ? new Date() : null, live ? 'finalized' : null])
    await repo(1, 'orig/app', '2025-01-01', sha(1)); await market(1)
    await repo(2, 'dead/old', '2024-01-01', sha(2)) // an abandoned project with no market
    await repo(3, 'heir/old', '2025-06-01', sha(2)); await market(3) // a fork of it that launched
    await repo(4, 'gone/thing', '2024-01-01', sha(4)); await market(4, 'failed')
    const candidate = (id, fullName, created, extra = {}) => ({ githubRepoId: BigInt(id), fullName, owner: fullName.split('/')[0], githubCreatedAt: new Date(created), ...extra })
    const fork = (parent, source = parent) => ({ fork: { parent, source } })
    const ref = (id, fullName) => ({ id: String(id), fullName })

    // Rule A: a fork of a launched repository (as parent, or as the root of its network) is refused.
    await assert.rejects(launchLineage(db, candidate(10, 'copy/app', '2026-01-01', fork(ref(1, 'orig/app')))), error =>
      error instanceof LineageError && /fork of orig\/app/.test(error.message) && error.original.mint === 'mint1')
    await assert.rejects(launchLineage(db, candidate(11, 'deep/app', '2026-01-01', fork(ref(10, 'copy/app'), ref(1, 'orig/app')))), /fork of orig\/app/)
    // Any other fork launches, labelled: a fork of the unlaunched original even though a sibling fork launched, and one whose
    // parent's launch failed.
    assert.deepEqual(await launchLineage(db, candidate(12, 'other/old', '2026-01-01', fork(ref(2, 'dead/old')))), { forkOf: ref(2, 'dead/old') })
    assert.deepEqual(await launchLineage(db, candidate(13, 'redo/thing', '2026-01-01', fork(ref(4, 'gone/thing')))), { forkOf: ref(4, 'gone/thing') })

    // Rule B: a fresh push of a launched repository's history, by another owner and created later, is refused.
    await assert.rejects(launchLineage(db, candidate(20, 'thief/app', '2026-02-01'), sha(1)), error =>
      /same first commit as orig\/app/.test(error.message) && error.original.fullName === 'orig/app')
    // The same owner moving the project to a new repository may launch it (a rename-and-relaunch).
    assert.deepEqual(await launchLineage(db, candidate(21, 'orig/app-v2', '2026-02-01'), sha(1)), { forkOf: null })
    // The original launching after its copy is never refused: the copy is the newer repository.
    assert.deepEqual(await launchLineage(db, candidate(2, 'dead/old', '2024-01-01'), sha(2)), { forkOf: null })
    // A repository is not a copy of itself; a failed launch is not a market; an unknown first commit skips the check.
    assert.deepEqual(await launchLineage(db, candidate(1, 'orig/app', '2025-01-01'), sha(1)), { forkOf: null })
    assert.deepEqual(await launchLineage(db, candidate(22, 'new/thing', '2026-01-01'), sha(4)), { forkOf: null })
    assert.deepEqual(await launchLineage(db, candidate(23, 'thief/app2', '2026-02-01'), null), { forkOf: null })
    // Unknown creation time: treated as the newer one, so a copy is refused.
    await assert.rejects(launchLineage(db, { ...candidate(24, 'thief/app3', '2026-02-01'), githubCreatedAt: undefined }, sha(1)), LineageError)
    // A launch still in progress counts as a market, but its mint is not named until the market is live.
    await repo(5, 'busy/app', '2025-01-01', sha(5)); await market(5, 'submitted')
    await assert.rejects(launchLineage(db, candidate(25, 'thief/busy', '2026-02-01'), sha(5)), error =>
      error instanceof LineageError && error.original.fullName === 'busy/app' && error.original.mint === null)

    // checkLaunchLineage reads the first commit only for a repository that is not a fork, stores what it read, and lets a launch
    // through (rechecked later) when GitHub cannot list the commits.
    await repo(30, 'fresh/app', '2026-03-01')
    const reads = [], logs = []
    const verdict = await checkLaunchLineage({ pool: db, repo: candidate(30, 'fresh/app', '2026-03-01'), readRoot: async name => { reads.push(name); return sha(30) } })
    assert.deepEqual(verdict, { forkOf: null }); assert.deepEqual(reads, ['fresh/app'])
    let stored = (await db.query('select root_commit, fork_parent_full_name, lineage_checked_at from repositories where github_repo_id = 30')).rows[0]
    assert.equal(stored.root_commit, sha(30)); assert.ok(stored.lineage_checked_at)
    await repo(31, 'flaky/app', '2026-03-01')
    assert.deepEqual(await checkLaunchLineage({ pool: db, repo: candidate(31, 'flaky/app', '2026-03-01'), log: (...args) => logs.push(args),
      readRoot: async () => { throw Error('GITHUB_COMMITS_HTTP_502') } }), { forkOf: null })
    stored = (await db.query('select root_commit, lineage_checked_at from repositories where github_repo_id = 31')).rows[0]
    assert.deepEqual(stored, { root_commit: null, lineage_checked_at: null }); assert.equal(logs.length, 1)
    await repo(32, 'kid/old', '2026-03-01')
    await checkLaunchLineage({ pool: db, repo: candidate(32, 'kid/old', '2026-03-01', fork(ref(2, 'dead/old'))),
      readRoot: async () => assert.fail('a fork needs no first commit') })
    assert.equal((await db.query('select fork_parent_full_name from repositories where github_repo_id = 32')).rows[0].fork_parent_full_name, 'dead/old')

    // The worker fills in markets launched before 0058. GitHub's answers: a repository it no longer serves is marked checked; an
    // archived one is still read without rewriting its row; a rate limit or outage is retried later without holding up the rest.
    await repo(6, 'old/archived', '2023-01-01'); await market(6)
    await repo(7, 'gone/deleted', '2023-01-01'); await market(7)
    await repo(8, 'odd/answer', '2023-01-01'); await market(8)
    await db.query('update repositories set lineage_checked_at = now() where github_repo_id not in (1, 3, 4, 6, 7, 8)')
    await db.query('update repositories set root_commit = null where github_repo_id = 1')
    let clock = 0
    const asked = []
    const repoFrom = (id, fullName, extra = {}) => ({ githubRepoId: BigInt(id), owner: fullName.split('/')[0], name: fullName.split('/')[1], fullName,
      description: null, avatarUrl: null, stars: 3, forks: 0, archived: false, githubUpdatedAt: new Date(), githubCreatedAt: new Date('2025-01-01'), ...extra })
    let outage = true
    const backfill = createLineageBackfill({ pool: db, limit: 10, now: () => clock, retryMs: 60_000,
      resolve: async id => {
        asked.push(id)
        if (id === '1') return repoFrom(1, 'orig/app-renamed')
        if (id === '3') { if (outage) throw Error('GITHUB_REPOSITORY_HTTP_503'); return repoFrom(3, 'heir/old') }
        if (id === '6') return repoFrom(6, 'old/archived-now', { archived: true })
        if (id === '7') return null
        if (id === '8') throw new RepositoryResolutionError('Repository identity mismatch')
        assert.fail(`repository ${id} has only a failed market or is already checked`)
      }, readRoot: async name => name === 'heir/old' ? sha(2) : sha(1) })
    assert.deepEqual(await backfill.runOnce(), [{ repoId: '1', fork: false, root: true }, { repoId: '3', error: 'GITHUB_REPOSITORY_HTTP_503' },
      { repoId: '6', fork: false, root: true, archived: true }, { repoId: '7', skipped: 'UNAVAILABLE_ON_GITHUB' }, { repoId: '8', skipped: 'UNAVAILABLE_ON_GITHUB' }])
    const rows = (await db.query(`select github_repo_id::text as id, full_name, root_commit, lineage_checked_at is not null as checked
      from repositories where github_repo_id in (1,3,4,6,7) order by 1`)).rows
    assert.deepEqual(rows, [{ id: '1', full_name: 'orig/app-renamed', root_commit: sha(1), checked: true },
      { id: '3', full_name: 'heir/old', root_commit: sha(2), checked: false }, { id: '4', full_name: 'gone/thing', root_commit: sha(4), checked: false },
      { id: '6', full_name: 'old/archived', root_commit: sha(1), checked: true }, { id: '7', full_name: 'gone/deleted', root_commit: null, checked: true }])
    // The outage is waited out, then read again; nothing else is asked.
    outage = false; asked.length = 0
    assert.deepEqual(await backfill.runOnce(), [])
    clock += 60_000
    assert.deepEqual(await backfill.runOnce(), [{ repoId: '3', fork: false, root: true }])
    assert.deepEqual(asked, ['3'])
    await recordLineage(db, candidate(3, 'heir/old', '2025-06-01'), { checked: false })
    assert.equal((await db.query('select root_commit from repositories where github_repo_id = 3')).rows[0].root_commit, sha(2), 'a missing read keeps the stored first commit')
  } finally { await db.query('rollback'); await db.end() }
})
