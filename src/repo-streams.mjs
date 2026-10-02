// Live building streams (drizzle/0046_repo_streams.sql). A repository admin, checked against GitHub immediately before
// every change, links where the build is streamed and can mark it live. Live ends by itself six hours after it was set.
// Pages only link out to the stream: no embeds, so no third-party frames or scripts.
export const STREAM_PLATFORMS = Object.freeze({ 'youtube.com': 'YouTube', 'www.youtube.com': 'YouTube', 'youtu.be': 'YouTube',
  'twitch.tv': 'Twitch', 'www.twitch.tv': 'Twitch', 'x.com': 'X', 'kick.com': 'Kick' })
export const STREAM_URL_MAX = 300
export const LIVE_WINDOW_HOURS = 6
const REPO_ID = /^[1-9]\d{0,18}$/
const INVALID_LINK = 'Use an https link to a YouTube, Twitch, X or Kick stream.'

// The canonical href of an allowlisted https stream link (no credentials, port or fragment, a path beyond "/"), or an error.
export function parseStreamUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > STREAM_URL_MAX) throw Error(text ? 'Stream links are limited to 300 characters.' : INVALID_LINK)
  let url
  try { url = new URL(text) } catch { throw Error(INVALID_LINK) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !Object.hasOwn(STREAM_PLATFORMS, url.hostname) ||
      url.pathname === '/') throw Error(INVALID_LINK)
  url.hash = ''
  if (url.href.length > STREAM_URL_MAX) throw Error('Stream links are limited to 300 characters.')
  return url.href
}

// Public view of a stored row; a row that no longer passes the link rules is not shown at all.
export function streamView(row, now = Date.now()) {
  if (!row) return null
  let url
  try { url = parseStreamUrl(row.url) } catch { return null }
  const until = row.liveUntil ? new Date(row.liveUntil) : null
  const live = Boolean(until && until.getTime() > now)
  return { url, platform: STREAM_PLATFORMS[new URL(url).hostname], live, liveUntil: live ? until.toISOString() : null }
}

export async function readRepoStream(pool, repoId, now = Date.now()) {
  if (!REPO_ID.test(String(repoId ?? ''))) return null
  const { rows: [row] } = await pool.query('select url, live_until as "liveUntil" from repo_streams where github_repo_id = $1', [String(repoId)])
  return streamView(row, now)
}

// verifyAuthority: the fresh GitHub admin check of the builder routes (app/lib/github-session.mjs); like the other
// maintainer actions, its result must be at most a minute old.
const AUTHORITY_MAX_AGE_MS = 60_000
export function createRepoStreams({ pool, now = Date.now }) {
  async function authorize(githubRepoId, verifyAuthority) {
    const repoId = String(githubRepoId ?? '')
    if (!REPO_ID.test(repoId)) throw Error('Invalid repository')
    const github = await verifyAuthority({ githubRepoId: BigInt(repoId) })
    const checkedAt = new Date(github?.verifiedAt).getTime()
    if (github?.verified !== true || github.permission !== 'admin' || String(github.githubRepoId) !== repoId ||
        !/^[1-9]\d*$/.test(String(github.githubUserId ?? '')) || !Number.isFinite(checkedAt) || now() - checkedAt > AUTHORITY_MAX_AGE_MS) {
      throw Error('Current GitHub admin permission required')
    }
    return { repoId, userId: String(github.githubUserId) }
  }
  const view = row => streamView(row, now())
  return {
    read: repoId => readRepoStream(pool, repoId, now()),
    // A new link keeps an unexpired live window; the window itself is never extended here.
    async save({ githubRepoId, url, verifyAuthority }) {
      const link = parseStreamUrl(url)
      const { repoId, userId } = await authorize(githubRepoId, verifyAuthority)
      const { rows: [row] } = await pool.query(`insert into repo_streams(github_repo_id, url, updated_by_github_user_id) values($1, $2, $3)
        on conflict (github_repo_id) do update set url = excluded.url, updated_by_github_user_id = excluded.updated_by_github_user_id,
          updated_at = now(), live_until = case when repo_streams.live_until > now() then repo_streams.live_until end
        returning url, live_until as "liveUntil"`, [repoId, link, userId])
      return view(row)
    },
    async setLive({ githubRepoId, live, verifyAuthority }) {
      if (typeof live !== 'boolean') throw Error('Invalid live state')
      const { repoId, userId } = await authorize(githubRepoId, verifyAuthority)
      const { rows: [row] } = await pool.query(`update repo_streams set updated_by_github_user_id = $3, updated_at = now(),
          live_until = case when $2::boolean then now() + make_interval(hours => $4) end
        where github_repo_id = $1 returning url, live_until as "liveUntil"`, [repoId, live, userId, LIVE_WINDOW_HOURS])
      if (!row) throw Error('Add a stream link first.')
      return view(row)
    },
    async remove({ githubRepoId, verifyAuthority }) {
      const { repoId } = await authorize(githubRepoId, verifyAuthority)
      await pool.query('delete from repo_streams where github_repo_id = $1', [repoId])
      return null
    },
  }
}
