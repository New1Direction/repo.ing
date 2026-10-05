import { githubApiHeaders } from './github-app-auth.mjs'
import { EarlyAccessError } from './early-access.mjs'
import { assertGithubRepoId } from './market-identity.mjs'

// A repository's contributors as GitHub lists them (GET /repos/{owner}/{repo}/contributors), for contributor early access
// (docs/EARLY_ACCESS.md): the accounts whose linked wallets may buy during the window. Read when an early access launch is
// prepared and stored as the repository's snapshot (early_access_contributors), replacing the previous one in one transaction.
//
// What GitHub's list is: accounts with at least one commit on the default branch, matched by commit author email; GitHub
// links only the first 500 author emails to accounts (the rest would be anonymous, and are not listed here), and the list can
// be cached for a while after new commits. Bots ([bot] logins, type Bot), organizations and anonymous entries are skipped.
const API = 'https://api.github.com'
export const CONTRIBUTOR_PAGE_SIZE = 100
// 500 linked emails at most: five full pages.
export const MAX_CONTRIBUTOR_PAGES = 5
// GitHub requests this installation keeps in reserve for the web's own reads (as src/dev-pulse.mjs): below it, a snapshot is
// refused until the rate limit resets rather than spending the reserve.
export const CONTRIBUTOR_RATE_FLOOR = 800
const USER_ID = /^[1-9]\d{0,15}$/
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const BOT_LOGIN = /\[bot\]$/i
const OWNER_OR_NAME = /^[A-Za-z0-9_.-]{1,100}$/

export const CONTRIBUTOR_ERRORS = Object.freeze({
  unavailable: 'Could not read this repository\'s contributors from GitHub. Try again in a few minutes.',
  busy: 'GitHub is busy right now, so the contributor list could not be read. Try again in a few minutes.',
  tooLarge: 'GitHub cannot list contributors for a repository this large, so early access is not available for it.',
  none: 'GitHub lists no contributors for this repository yet, so early access would have no one to open to. Launch without early access.',
})

// One page of GitHub's answer → [{ githubUserId, githubLogin, contributions }] for personal accounts only.
export function contributorsFromPage(entries) {
  if (!Array.isArray(entries)) throw new EarlyAccessError(CONTRIBUTOR_ERRORS.unavailable, 503)
  return entries.flatMap(entry => {
    const id = typeof entry?.id === 'number' ? String(entry.id) : null, login = entry?.login, contributions = entry?.contributions
    if (entry?.type !== 'User' || !id || !USER_ID.test(id) || BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER)) return []
    if (typeof login !== 'string' || !GITHUB_LOGIN.test(login) || BOT_LOGIN.test(login)) return []
    if (!Number.isSafeInteger(contributions) || contributions < 1) return []
    return [{ githubUserId: id, githubLogin: login, contributions: Math.min(contributions, 2_147_483_647) }]
  })
}

// pausedUntil is per process, like src/dev-pulse.mjs: after a response under the floor (or a refusal), no snapshot is read
// again until GitHub's reset time.
let pausedUntil = 0
export const resetContributorPause = () => { pausedUntil = 0 }

// githubRepoId and fullName ("owner/name") as GitHub resolved them just now. Returns every listed contributor (deduplicated by
// account id).
export async function fetchRepositoryContributors({ githubRepoId, fullName, fetchImpl = fetch, now = Date.now,
  headers = () => githubApiHeaders('repo.ing-early-access', fetchImpl) }) {
  assertGithubRepoId(githubRepoId)
  const [owner, name, extra] = String(fullName ?? '').split('/')
  if (extra !== undefined || !OWNER_OR_NAME.test(owner ?? '') || !OWNER_OR_NAME.test(name ?? '')) throw Error('Repository full name required')
  if (now() < pausedUntil) throw new EarlyAccessError(CONTRIBUTOR_ERRORS.busy, 503)
  const byId = new Map()
  for (let page = 1; page <= MAX_CONTRIBUTOR_PAGES; page++) {
    let response
    try {
      response = await fetchImpl(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contributors?per_page=${CONTRIBUTOR_PAGE_SIZE}&page=${page}`,
        { cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: await headers() })
    } catch { throw new EarlyAccessError(CONTRIBUTOR_ERRORS.unavailable, 503) }
    const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? Number.POSITIVE_INFINITY)
    const limited = response.status === 429 || (response.status === 403 && remaining === 0)
    if (limited || remaining < CONTRIBUTOR_RATE_FLOOR) {
      pausedUntil = Math.max(pausedUntil, now() + 60_000, Number(response.headers.get('x-ratelimit-reset') || 0) * 1000,
        now() + Number(response.headers.get('retry-after') || 0) * 1000)
    }
    if (limited) { await response.body?.cancel(); throw new EarlyAccessError(CONTRIBUTOR_ERRORS.busy, 503) }
    // An empty repository has no contributors (204).
    if (response.status === 204) { await response.body?.cancel(); break }
    if (response.status === 403) {
      const body = await response.json().catch(() => null)
      if (/too large/i.test(String(body?.message ?? ''))) throw new EarlyAccessError(CONTRIBUTOR_ERRORS.tooLarge)
      throw new EarlyAccessError(CONTRIBUTOR_ERRORS.unavailable, 503)
    }
    if (!response.ok) { await response.body?.cancel(); throw new EarlyAccessError(CONTRIBUTOR_ERRORS.unavailable, 503) }
    const entries = await response.json().catch(() => null)
    for (const contributor of contributorsFromPage(entries)) if (!byId.has(contributor.githubUserId)) byId.set(contributor.githubUserId, contributor)
    if (entries.length < CONTRIBUTOR_PAGE_SIZE) break
    // More pages are listed but the reserve is reached: refuse rather than store a partial list.
    if (remaining < CONTRIBUTOR_RATE_FLOOR && page < MAX_CONTRIBUTOR_PAGES) throw new EarlyAccessError(CONTRIBUTOR_ERRORS.busy, 503)
  }
  return [...byId.values()]
}

// The repository's snapshot replaced in one transaction (executor: a pg Pool). The repository row must exist (it is saved before
// a launch is prepared).
export async function replaceContributorSnapshot(pool, githubRepoId, contributors) {
  const repoId = assertGithubRepoId(String(githubRepoId)).toString()
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('delete from early_access_contributors where github_repo_id = $1', [repoId])
    if (contributors.length) {
      await client.query(`insert into early_access_contributors (github_repo_id, github_user_id, github_login, contributions, captured_at)
        select $1, item.id, item.login, item.contributions, now()
        from unnest($2::bigint[], $3::text[], $4::integer[]) as item(id, login, contributions)`,
      [repoId, contributors.map(c => c.githubUserId), contributors.map(c => c.githubLogin), contributors.map(c => c.contributions)])
    }
    await client.query('commit')
  } catch (error) { await client.query('rollback').catch(() => {}); throw error } finally { client.release() }
}

// The repository's stored snapshot, by account id.
export async function contributorSnapshot(executor, githubRepoId) {
  const { rows } = await executor.query(`select github_user_id::text as "githubUserId", github_login as "githubLogin", contributions,
    captured_at as "capturedAt" from early_access_contributors where github_repo_id = $1 order by github_user_id`, [assertGithubRepoId(String(githubRepoId)).toString()])
  return rows
}
