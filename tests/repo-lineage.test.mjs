import test from 'node:test'
import assert from 'node:assert/strict'
import { forkOf, resolvePublicRepository, RepositoryResolutionError } from '../src/github.mjs'
import { checkLaunchLineage, createLineageBackfill, launchLineage, LineageError, recordLineage, rootCommit } from '../src/repo-lineage.mjs'
import { launchFailure } from '../src/launch-failure.mjs'
import { selectLaunchableTrends } from '../src/trend-launchable.mjs'

const sha = n => n.toString(16).padStart(40, '0')
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
  // A last page that is not GitHub's API is never followed.
  assert.equal(await rootCommit('me/app', async () => json([{ sha: sha(3) }], { link: '<https://evil.example/x>; rel="last"' })), sha(3))
})

test('a refusal is final in the launch review, with its own code', () => {
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
    await db.query('create temporary table markets(id serial, github_repo_id bigint, status text, mint text)')
    const repo = (id, fullName, created, root = null) => db.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived,
      github_updated_at, github_created_at, root_commit) values($1,$2,$3,$4,0,0,false,now(),$5,$6)`, [id, fullName.split('/')[0], fullName.split('/')[1], fullName, created, root])
    const market = (id, status = 'confirmed') => db.query('insert into markets(github_repo_id, status, mint) values($1,$2,$3)', [id, status, `mint${id}`])
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

    // The worker fills in markets launched before 0058, and marks a repository GitHub no longer serves as checked.
    await db.query('update repositories set lineage_checked_at = now() where github_repo_id not in (1, 3, 4)')
    await db.query('update repositories set root_commit = null where github_repo_id = 1')
    const backfill = createLineageBackfill({ pool: db, limit: 10,
      resolve: async id => {
        if (id === '4') throw new RepositoryResolutionError('Archived repositories are unsupported')
        if (id === '3') throw Error('socket hang up')
        return { githubRepoId: BigInt(id), owner: 'orig', name: 'app', fullName: 'orig/app-renamed', description: null, avatarUrl: null, stars: 3, forks: 0,
          archived: false, githubUpdatedAt: new Date(), githubCreatedAt: new Date('2025-01-01') }
      }, readRoot: async () => sha(1) })
    assert.deepEqual(await backfill.runOnce(), [{ repoId: '1', fork: false, root: true }, { repoId: '3', error: 'LINEAGE_UNAVAILABLE' },
      { repoId: '4', skipped: 'UNAVAILABLE_ON_GITHUB' }])
    const rows = (await db.query('select github_repo_id::text as id, full_name, root_commit, lineage_checked_at is not null as checked from repositories where github_repo_id in (1,3,4) order by 1')).rows
    assert.deepEqual(rows, [{ id: '1', full_name: 'orig/app-renamed', root_commit: sha(1), checked: true },
      { id: '3', full_name: 'heir/old', root_commit: sha(2), checked: false }, { id: '4', full_name: 'gone/thing', root_commit: sha(4), checked: true }])
    await recordLineage(db, candidate(3, 'heir/old', '2025-06-01'), { checked: false })
    assert.equal((await db.query('select root_commit from repositories where github_repo_id = 3')).rows[0].root_commit, sha(2), 'a missing read keeps the stored first commit')
  } finally { await db.query('rollback'); await db.end() }
})
