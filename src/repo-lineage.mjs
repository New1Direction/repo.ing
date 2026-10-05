import { githubApiHeaders } from './github-app-auth.mjs'
import { readLaunchedRepositoryById, RepositoryResolutionError } from './github.mjs'
import { persistLaunchRepository } from './repository-store.mjs'
import { assertGithubRepoId } from './market-identity.mjs'

// The fork guard (drizzle/0058_repository_lineage.sql; docs/FORK_GUARD.md). Buyers must not mistake a copy for a launched
// original, while a fork that carries an abandoned project forward can still have its market.
// - A GitHub fork whose parent (the repository it was forked from) or source (the root of its fork network) already has a
//   market cannot launch. Any other fork can, shown as "Fork of <parent>".
// - A repository that is not a GitHub fork but starts from an older launched repository's first commit (a copy pushed fresh)
//   cannot launch either, unless both belong to the same GitHub owner: moving one's own project to a new repository is not
//   a copy. Older by GitHub's creation time, so an original that launches after its copy is never refused.
// The first commit is read at launch prepare and stored per repository; markets launched before 0058 are filled in by the
// worker (createLineageBackfill). A first commit GitHub cannot list right now skips the copy check rather than block a launch.

export class LineageError extends Error {
  constructor(message, original) {
    super(message)
    this.name = 'LineageError'; this.status = 409; this.code = 'COPY_OF_LAUNCHED_REPOSITORY'; this.original = original
  }
}

// How long an advisory check (checkLaunchLineage { advisory }) waits for a first commit it has never read.
export const ADVISORY_DEADLINE_MS = 3000
const SHA = /^[0-9a-f]{40}$/
// A repository's first commit on its default branch: the last page of a one-per-page commit list, which GitHub names in the
// Link header of any list longer than one page. null for an empty repository. Throws when GitHub cannot list the commits, or
// names no last page of its own API. signal: an overall deadline on top of each request's own 10 s.
export async function rootCommit(fullName, fetchImpl = fetch, signal = undefined) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName ?? '')) throw Error('LINEAGE_REPOSITORY_INVALID')
  const headers = await githubApiHeaders('repo.ing-launch-coordinator', fetchImpl)
  const get = async url => {
    const timeout = AbortSignal.timeout(10000)
    const response = await fetchImpl(url, { headers, cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (response.status === 409) return null // GitHub: "Git Repository is empty."
    if (!response.ok) throw Error(`GITHUB_COMMITS_HTTP_${response.status}`)
    return response
  }
  const first = await get(`https://api.github.com/repos/${fullName}/commits?per_page=1`)
  if (!first) return null
  const link = first.headers.get('link')
  // No Link header: one page, one commit. A Link header without GitHub's own last page would leave only the newest commit.
  const last = link ? /<(https:\/\/api\.github\.com\/[^>]+)>;\s*rel="last"/.exec(link)?.[1] : null
  if (link && !last) throw Error('GITHUB_COMMITS_NO_LAST_PAGE')
  const page = last ? await get(last) : first
  if (!page) return null
  const [commit] = await page.json()
  return SHA.test(commit?.sha ?? '') ? commit.sha : null
}

const time = value => value == null ? null : new Date(value)
// The original's mint is named (for a link to its market) only once that market is live: confirmed, indexed and finalized.
const LIVE_MINT = `case when m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized' then m.mint end`

// May this repository launch? repo: as resolved from GitHub ({ githubRepoId or repoId, fullName, owner, githubCreatedAt, fork }).
// root: its first commit (only read for a repository that is not a fork), or null. Throws LineageError naming the launched
// original ({ fullName, mint }, mint null until its market is live); otherwise returns { forkOf } (the parent to label it with, or null).
// Any market but a failed one counts, a launch in progress included.
export async function launchLineage(pool, repo, root = null) {
  const id = String(repo.githubRepoId ?? repo.repoId)
  if (repo.fork) {
    const lineage = [repo.fork.parent, repo.fork.source].filter(Boolean).map(ref => ref.id)
    if (lineage.length) {
      const { rows: [original] } = await pool.query(`select r.full_name as "fullName", ${LIVE_MINT} as mint from markets m
        join repositories r on r.github_repo_id = m.github_repo_id where m.github_repo_id = any($1::bigint[]) and m.status <> 'failed'
        order by m.id limit 1`, [lineage])
      if (original) throw new LineageError(`This repository is a fork of ${original.fullName}, which already has a market on repo.ing.`, original)
    }
    return { forkOf: repo.fork.parent }
  }
  if (root) {
    const { rows: [original] } = await pool.query(`select r.full_name as "fullName", ${LIVE_MINT} as mint from repositories r
      join markets m on m.github_repo_id = r.github_repo_id
      where r.root_commit = $1 and r.github_repo_id <> $2 and m.status <> 'failed' and lower(r.owner) <> lower($4)
        and (r.github_created_at is null or $3::timestamptz is null or r.github_created_at < $3)
      order by r.github_created_at nulls first, m.id limit 1`, [root, id, time(repo.githubCreatedAt), repo.owner ?? ''])
    if (original) throw new LineageError(`This repository starts from the same first commit as ${original.fullName}, which already has a market on repo.ing.`, original)
  }
  return { forkOf: null }
}

// Stores what was read: the first commit (or null), the fork parent, and GitHub's creation time when none is stored. checked:
// the read is complete (a fork, or a first commit read, empty included), so it is not read again.
export async function recordLineage(pool, repo, { root = null, checked = true } = {}) {
  await pool.query(`update repositories set root_commit = coalesce($2, root_commit), fork_parent_id = $3, fork_parent_full_name = $4,
    lineage_checked_at = case when $5 then now() else lineage_checked_at end, github_created_at = coalesce(github_created_at, $6)
    where github_repo_id = $1`,
  [String(repo.githubRepoId ?? repo.repoId), root, repo.fork?.parent?.id ?? null, repo.fork?.parent?.fullName ?? null, checked, time(repo.githubCreatedAt)])
}

// What an earlier check stored: { root, checkedAt }, or null when it cannot be read (then the repository is read as if new).
async function storedLineage(pool, id) {
  try {
    const { rows: [row] } = await pool.query('select root_commit as root, lineage_checked_at as "checkedAt" from repositories where github_repo_id = $1', [id])
    return row ?? null
  } catch { return null }
}

// Every launch path: the verdict.
// - Launch prepare (authoritative) always reads the first commit again, since a repository may have pushed another history
//   since it was last checked, and stores what it read.
// - advisory: the resolve API, the launch page and agent tools, each followed by prepare's own check. A repository checked
//   before uses what was stored and writes nothing. One never checked is read within ADVISORY_DEADLINE_MS and stored.
// A first commit GitHub cannot list in time skips the copy check (never blocks a launch on a GitHub hiccup); it is read again later.
export async function checkLaunchLineage({ pool, repo, fetchImpl = fetch, readRoot = rootCommit, log = console.warn, advisory = false,
  deadlineMs = ADVISORY_DEADLINE_MS }) {
  // A Hugging Face market id never reaches GitHub or a lineage read (src/market-identity.mjs).
  const id = String(repo.githubRepoId ?? repo.repoId)
  assertGithubRepoId(id)
  const stored = advisory ? await storedLineage(pool, id) : null
  if (stored?.checkedAt) return launchLineage(pool, repo, repo.fork ? null : stored.root)
  let root = null, checked = true
  if (!repo.fork) {
    try { root = await readRoot(repo.fullName, fetchImpl, advisory ? AbortSignal.timeout(deadlineMs) : undefined) }
    catch (error) { checked = false; log('lineage_root_unavailable', { repo: repo.fullName, code: String(error?.name === 'TimeoutError' ? 'TIMEOUT' : error?.message ?? 'error').slice(0, 40) }) }
  }
  const verdict = await launchLineage(pool, repo, root)
  try { await recordLineage(pool, repo, { root, checked }) } catch { /* Stored for later checks only. */ }
  return verdict
}

// The worker fills in lineage for markets launched before 0058, and for any repository whose first commit could not be read,
// a few per run.
// - A repository GitHub no longer serves publicly (deleted, private) is marked checked as it is.
// - An archived one is still read, since its first commit is still a launched original's. Its stored row is left as it is,
//   because the resolve and trend surfaces read its archived flag.
// - Any other failure (a rate limit, an outage, a timeout) is retried after retryMs, without holding up the others.
// Repositories whose only market failed are skipped: a failed launch is not a market.
export function createLineageBackfill({ pool, fetchImpl = fetch, limit = 5, resolve = readLaunchedRepositoryById, readRoot = rootCommit,
  retryMs = 30 * 60_000, now = Date.now }) {
  const retryAt = new Map()
  const markChecked = repoId => pool.query('update repositories set lineage_checked_at = now() where github_repo_id = $1', [repoId])
  return { async runOnce() {
    const { rows } = await pool.query(`select r.github_repo_id::text as "repoId" from repositories r
      where r.lineage_checked_at is null and r.source = 'github'
        and exists (select 1 from markets m where m.github_repo_id = r.github_repo_id and m.status <> 'failed')
      order by r.github_repo_id limit $1`, [limit * 10])
    const results = []
    for (const { repoId } of rows.filter(row => !(retryAt.get(row.repoId) > now())).slice(0, limit)) {
      try {
        assertGithubRepoId(repoId)
        const repo = await resolve(repoId, fetchImpl)
        if (!repo) { await markChecked(repoId); results.push({ repoId, skipped: 'UNAVAILABLE_ON_GITHUB' }); continue }
        if (!repo.archived) await persistLaunchRepository(pool, repo)
        const root = repo.fork ? null : await readRoot(repo.fullName, fetchImpl)
        await recordLineage(pool, repo, { root })
        retryAt.delete(repoId)
        results.push({ repoId, fork: Boolean(repo.fork), root: Boolean(root), ...repo.archived ? { archived: true } : {} })
      } catch (error) {
        // A malformed or mismatched answer from GitHub is not retried; anything else is.
        if (error instanceof RepositoryResolutionError) { await markChecked(repoId); results.push({ repoId, skipped: 'UNAVAILABLE_ON_GITHUB' }); continue }
        retryAt.set(repoId, now() + retryMs)
        results.push({ repoId, error: /^[A-Z][A-Z0-9_]{3,60}$/.test(error?.message ?? '') ? error.message : 'LINEAGE_UNAVAILABLE' })
      }
    }
    return results
  } }
}
