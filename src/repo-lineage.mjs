import { githubApiHeaders } from './github-app-auth.mjs'
import { resolvePublicRepositoryById, RepositoryResolutionError } from './github.mjs'
import { persistLaunchRepository } from './repository-store.mjs'

// The fork guard (drizzle/0058_repository_lineage.sql; docs/FORK_GUARD.md). Buyers must not mistake a copy for a launched
// original, while a fork that carries an abandoned project forward can still have its market.
// - A GitHub fork whose parent (the repository it was forked from) or source (the root of its fork network) already has a
//   market cannot launch. Any other fork can, shown as "Fork of <parent>".
// - A repository that is not a GitHub fork but starts from an older launched repository's first commit (a copy pushed fresh)
//   cannot launch either, unless both belong to the same GitHub owner: moving one's own project to a new repository is not
//   a copy. Older by GitHub's creation time, so an original that launches after its copy is never refused.
// The first commit is read at launch review and stored per repository; markets launched before 0058 are filled in by the
// worker (createLineageBackfill). A first commit GitHub cannot list right now skips the copy check rather than block a launch.

export class LineageError extends Error {
  constructor(message, original) {
    super(message)
    this.status = 409; this.code = 'COPY_OF_LAUNCHED_REPOSITORY'; this.original = original
  }
}

const SHA = /^[0-9a-f]{40}$/
// A repository's first commit on its default branch: the last page of a one-per-page commit list (the Link header names it).
// null for an empty repository. Throws when GitHub cannot list the commits.
export async function rootCommit(fullName, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName ?? '')) throw Error('LINEAGE_REPOSITORY_INVALID')
  const headers = await githubApiHeaders('repo.ing-launch-coordinator', fetchImpl)
  const get = async url => {
    const response = await fetchImpl(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) })
    if (response.status === 409) return null // GitHub: "Git Repository is empty."
    if (!response.ok) throw Error(`GITHUB_COMMITS_HTTP_${response.status}`)
    return response
  }
  const first = await get(`https://api.github.com/repos/${fullName}/commits?per_page=1`)
  if (!first) return null
  const last = /<(https:\/\/api\.github\.com\/[^>]+)>;\s*rel="last"/.exec(first.headers.get('link') ?? '')?.[1]
  const page = last ? await get(last) : first
  if (!page) return null
  const [commit] = await page.json()
  return SHA.test(commit?.sha ?? '') ? commit.sha : null
}

const time = value => value == null ? null : new Date(value)

// May this repository launch? repo: as resolved from GitHub ({ githubRepoId or repoId, fullName, owner, githubCreatedAt, fork }).
// root: its first commit (only read for a repository that is not a fork), or null. Throws LineageError naming the launched
// original; otherwise returns { forkOf } (the parent to label it with, or null).
export async function launchLineage(pool, repo, root = null) {
  const id = String(repo.githubRepoId ?? repo.repoId)
  if (repo.fork) {
    const lineage = [repo.fork.parent, repo.fork.source].filter(Boolean).map(ref => ref.id)
    if (lineage.length) {
      const { rows: [original] } = await pool.query(`select r.full_name as "fullName", m.mint from markets m
        join repositories r on r.github_repo_id = m.github_repo_id where m.github_repo_id = any($1::bigint[]) and m.status <> 'failed'
        order by m.id limit 1`, [lineage])
      if (original) throw new LineageError(`This repository is a fork of ${original.fullName}, which already has a market on repo.ing.`, original)
    }
    return { forkOf: repo.fork.parent }
  }
  if (root) {
    const { rows: [original] } = await pool.query(`select r.full_name as "fullName", m.mint from repositories r
      join markets m on m.github_repo_id = r.github_repo_id
      where r.root_commit = $1 and r.github_repo_id <> $2 and m.status <> 'failed' and lower(r.owner) <> lower($4)
        and (r.github_created_at is null or $3::timestamptz is null or r.github_created_at < $3)
      order by r.github_created_at nulls first, m.id limit 1`, [root, id, time(repo.githubCreatedAt), repo.owner ?? ''])
    if (original) throw new LineageError(`This repository starts from the same first commit as ${original.fullName}, which already has a market on repo.ing.`, original)
  }
  return { forkOf: null }
}

// Stores what was read: the first commit (or null) and the fork parent. checked: the read is complete (a fork, or a first
// commit read, empty included), so the worker does not read it again.
export async function recordLineage(pool, repo, { root = null, checked = true } = {}) {
  await pool.query(`update repositories set root_commit = coalesce($2, root_commit), fork_parent_id = $3, fork_parent_full_name = $4,
    lineage_checked_at = case when $5 then now() else lineage_checked_at end where github_repo_id = $1`,
  [String(repo.githubRepoId ?? repo.repoId), root, repo.fork?.parent?.id ?? null, repo.fork?.parent?.fullName ?? null, checked])
}

// Every launch path: the verdict, with its reads stored. A first commit GitHub cannot list right now skips the copy check
// (never blocks a launch on a GitHub hiccup) and is read again later.
export async function checkLaunchLineage({ pool, repo, fetchImpl = fetch, readRoot = rootCommit, log = console.warn }) {
  let root = null, checked = true
  if (!repo.fork) {
    try { root = await readRoot(repo.fullName, fetchImpl) }
    catch (error) { checked = false; log('lineage_root_unavailable', { repo: repo.fullName, code: error?.message?.slice(0, 40) ?? 'error' }) }
  }
  const verdict = await launchLineage(pool, repo, root)
  try { await recordLineage(pool, repo, { root, checked }) } catch { /* Stored for later checks only. */ }
  return verdict
}

// The worker fills in lineage for markets launched before 0058 (and any repository whose first commit could not be read),
// a few per run. A repository GitHub no longer serves publicly (archived, private, deleted) is marked checked as it is.
export function createLineageBackfill({ pool, fetchImpl = fetch, limit = 5, resolve = resolvePublicRepositoryById, readRoot = rootCommit }) {
  return { async runOnce() {
    const { rows } = await pool.query(`select r.github_repo_id::text as "repoId" from repositories r
      where r.lineage_checked_at is null and r.source = 'github' and exists (select 1 from markets m where m.github_repo_id = r.github_repo_id)
      order by r.github_repo_id limit $1`, [limit])
    const results = []
    for (const { repoId } of rows) {
      try {
        const repo = await resolve(repoId, fetchImpl)
        await persistLaunchRepository(pool, repo)
        const root = repo.fork ? null : await readRoot(repo.fullName, fetchImpl)
        await recordLineage(pool, repo, { root })
        results.push({ repoId, fork: Boolean(repo.fork), root: Boolean(root) })
      } catch (error) {
        if (error instanceof RepositoryResolutionError) {
          await pool.query('update repositories set lineage_checked_at = now() where github_repo_id = $1', [repoId])
          results.push({ repoId, skipped: 'UNAVAILABLE_ON_GITHUB' })
        } else results.push({ repoId, error: /^[A-Z][A-Z0-9_]{3,60}$/.test(error?.message ?? '') ? error.message : 'LINEAGE_UNAVAILABLE' })
      }
    }
    return results
  } }
}
