import { githubApiHeaders } from './github-app-auth.mjs'
import { githubTime } from './github.mjs'
import { assertGithubRepoId } from './market-identity.mjs'

// Dev Pulse collector: public GitHub activity for live markets' repositories, read by the worker. Every GitHub read is a
// conditional request (If-None-Match), so an unchanged repository costs nothing against the rate limit; commits and merged
// pull requests are re-read only after the repository's pushed_at moves. Hacker News stories come from the public Algolia
// API. Rows hold public data only; the web reads them for token pages, the price chart and the home ticker.
const API = 'https://api.github.com'
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000
export const PULSE_WINDOW_DAYS = 14
export const STAR_SPIKE = 10
const STAR_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]
const HN_MIN_POINTS = 10, HN_EVERY = 30 * MINUTE, COMMIT_PAGE = 100, MAX_COMMIT_PAGES = 10
// GitHub requests this installation keeps in reserve for the web's own reads (repository refreshes, verification).
const RATE_FLOOR = 800

const clean = (text, max = 140) => String(text ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, max)
const githubUrl = url => typeof url === 'string' && url.startsWith('https://github.com/') ? url : null
const iso = ms => new Date(ms).toISOString()
const hourStart = ms => Math.floor(ms / HOUR) * HOUR
const dayStart = ms => Math.floor(ms / DAY) * DAY
export const pulseWindowStart = now => dayStart(now) - (PULSE_WINDOW_DAYS - 1) * DAY

export function commitEvents(commits) {
  return (Array.isArray(commits) ? commits : []).flatMap(item => {
    const at = Date.parse(item?.commit?.committer?.date ?? item?.commit?.author?.date)
    if (typeof item?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(item.sha) || !Number.isFinite(at)) return []
    return [{ kind: 'commit', sourceId: item.sha, occurredAt: iso(at), title: clean(item.commit.message) || 'Commit',
      detail: clean(item.author?.login ?? item.commit?.author?.name, 39) || null, url: githubUrl(item.html_url), amount: null }]
  })
}

export function releaseEvents(releases) {
  return (Array.isArray(releases) ? releases : []).flatMap(item => {
    const at = Date.parse(item?.published_at)
    if (item?.draft || !Number.isSafeInteger(item?.id) || !Number.isFinite(at)) return []
    const tag = clean(item.tag_name, 60), name = clean(item.name, 100)
    return [{ kind: 'release', sourceId: String(item.id), occurredAt: iso(at), title: name || tag || 'New release',
      detail: [name && tag && name !== tag ? tag : null, item.prerelease ? 'pre-release' : null].filter(Boolean).join(' · ') || null,
      url: githubUrl(item.html_url), amount: null }]
  })
}

export function mergeEvents(pulls, since) {
  return (Array.isArray(pulls) ? pulls : []).flatMap(item => {
    const at = Date.parse(item?.merged_at)
    if (!Number.isSafeInteger(item?.number) || !Number.isFinite(at) || at < since) return []
    return [{ kind: 'merge', sourceId: String(item.number), occurredAt: iso(at), title: `#${item.number} ${clean(item.title, 120)}`.trim(),
      detail: clean(item.user?.login, 39) || null, url: githubUrl(item.html_url), amount: null }]
  })
}

// A star spike: the total grew by at least 10 stars (and 0.5% of the total, so big repositories need a real surge) since
// the last snapshot from an earlier hour. GitHub no longer lists other repositories' stargazers with timestamps.
export function starSpikeEvent(previous, current, now) {
  if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(current)) return null
  const gained = current - previous
  if (gained < Math.max(STAR_SPIKE, Math.ceil(current * 0.005))) return null
  const hour = iso(hourStart(now))
  return { kind: 'stars', sourceId: `hour:${hour}`, occurredAt: hour, title: `+${gained.toLocaleString('en-US')} stars`, detail: 'Star spike', url: null, amount: gained }
}

// Milestones crossed between two observed totals. The first observation has no previous total, so it never back-fills
// milestones a repository passed before Dev Pulse watched it.
export function milestoneEvents(previous, current, at, fullName) {
  if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(current) || current <= previous) return []
  return STAR_MILESTONES.filter(mark => previous < mark && current >= mark).map(mark => ({ kind: 'stars', sourceId: `milestone:${mark}`,
    occurredAt: at, title: `${mark.toLocaleString('en-US')} stars`, detail: null, url: fullName ? `https://github.com/${fullName}` : null, amount: mark }))
}

export function hnEvents(hits, fullName) {
  const target = `/${String(fullName).toLowerCase()}`
  return (Array.isArray(hits) ? hits : []).flatMap(hit => {
    let link
    try { link = new URL(hit?.url) } catch { return [] }
    const path = link.pathname.replace(/\/+$/, '').toLowerCase()
    const at = Date.parse(hit.created_at), points = Number(hit.points)
    if (link.protocol !== 'https:' || link.hostname.replace(/^www\./, '') !== 'github.com' || (path !== target && !path.startsWith(`${target}/`)) ||
      !/^\d+$/.test(String(hit.objectID)) || !Number.isFinite(at) || !(points >= HN_MIN_POINTS)) return []
    const comments = Number.isSafeInteger(hit.num_comments) ? hit.num_comments : 0
    return [{ kind: 'hn', sourceId: String(hit.objectID), occurredAt: iso(at), title: clean(hit.title, 140) || 'Hacker News story',
      detail: `${points.toLocaleString('en-US')} points · ${comments.toLocaleString('en-US')} comments`, url: `https://news.ycombinator.com/item?id=${hit.objectID}`, amount: points }]
  })
}

// Busy repositories are checked every 10 minutes, quiet ones every 30, dormant ones every 3 hours.
export function nextCheckDelay(pushedAt, now) {
  const quietFor = now - Date.parse(pushedAt)
  return !(quietFor < 30 * DAY) ? 3 * HOUR : quietFor < 3 * DAY ? 10 * MINUTE : 30 * MINUTE
}

export function createPulseStore(pool) {
  return {
    async due(limit, excluded) {
      const { rows } = await pool.query(`select live.github_repo_id::text as "repoId", r.full_name as "fullName",
          s.full_name as "knownName", s.default_branch as "defaultBranch", s.stars, s.pushed_at as "pushedAt",
          s.activity_read_for as "activityReadFor", coalesce(s.etags, '{}'::jsonb) as etags, s.hn_checked_at as "hnCheckedAt",
          r.github_created_at is null as "needsCreatedAt",
          (select h.stars_total from repo_pulse_star_hours h where h.github_repo_id = live.github_repo_id and h.hour < date_trunc('hour', now())
            order by h.hour desc limit 1) as "starsBefore"
        from (select distinct github_repo_id from markets where status = 'confirmed') live
        join repositories r on r.github_repo_id = live.github_repo_id and r.source = 'github'
        left join repo_pulse_state s on s.github_repo_id = live.github_repo_id
        where not (live.github_repo_id::text = any($2::text[])) and (s.next_check_at is null or s.next_check_at <= now())
        order by s.next_check_at nulls first, live.github_repo_id limit $1`, [limit, [...excluded]])
      return rows
    },
    async save(repoId, outcome) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        if (outcome.events.length) await client.query(`insert into repo_pulse_events (github_repo_id, kind, source_id, occurred_at, title, detail, url, amount)
          select $1, x.kind, x."sourceId", x."occurredAt", x.title, x.detail, x.url, x.amount
          from jsonb_to_recordset($2::jsonb) as x(kind text, "sourceId" text, "occurredAt" timestamptz, title text, detail text, url text, amount integer)
          on conflict (github_repo_id, kind, source_id) do update set occurred_at = excluded.occurred_at, title = excluded.title,
            detail = excluded.detail, url = excluded.url, amount = excluded.amount
          where (repo_pulse_events.occurred_at, repo_pulse_events.title, repo_pulse_events.detail, repo_pulse_events.url, repo_pulse_events.amount)
            is distinct from (excluded.occurred_at, excluded.title, excluded.detail, excluded.url, excluded.amount)`, [repoId, JSON.stringify(outcome.events)])
        if (outcome.starHours.length) await client.query(`insert into repo_pulse_star_hours (github_repo_id, hour, stars_total)
          select $1, x.hour, x."starsTotal" from jsonb_to_recordset($2::jsonb) as x(hour timestamptz, "starsTotal" integer)
          on conflict (github_repo_id, hour) do update set stars_total = excluded.stars_total where repo_pulse_star_hours.stars_total <> excluded.stars_total`,
          [repoId, JSON.stringify(outcome.starHours)])
        const s = outcome.state
        await client.query(`insert into repo_pulse_state (github_repo_id, full_name, default_branch, stars, pushed_at, activity_read_for, etags,
            hn_checked_at, checked_at, next_check_at, error)
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
          on conflict (github_repo_id) do update set full_name = excluded.full_name, default_branch = excluded.default_branch, stars = excluded.stars,
            pushed_at = excluded.pushed_at, activity_read_for = excluded.activity_read_for, etags = excluded.etags, hn_checked_at = excluded.hn_checked_at,
            checked_at = excluded.checked_at, next_check_at = excluded.next_check_at, error = excluded.error`,
          [repoId, s.fullName, s.defaultBranch, s.stars, s.pushedAt, s.activityReadFor, JSON.stringify(s.etags), s.hnCheckedAt,
            s.checkedAt, s.nextCheckAt, s.error])
        // Fresh star and fork counts for market lists and quality signals, and the creation time once (it never changes).
        // Repository identity (owner, name) is left to the launch and lookup paths.
        const r = outcome.repository
        if (r) await client.query(`update repositories set stars = $2, forks = coalesce($3, forks), github_created_at = coalesce(github_created_at, $4)
          where github_repo_id = $1 and (stars <> $2 or forks <> coalesce($3, forks) or (github_created_at is null and $4::timestamptz is not null))`,
          [repoId, r.stars, r.forks, r.createdAt])
        await client.query('commit')
      } catch (error) { await client.query('rollback').catch(() => {}); throw error } finally { client.release() }
    },
    async fail(repoId, error, nextCheckAt) {
      await pool.query(`insert into repo_pulse_state (github_repo_id, error, checked_at, next_check_at) values ($1, $2, now(), $3)
        on conflict (github_repo_id) do update set error = excluded.error, checked_at = excluded.checked_at, next_check_at = excluded.next_check_at`,
        [repoId, String(error).slice(0, 200), nextCheckAt])
    },
    // Commits are only shown for 14 days and star hours for 7; keep a margin, drop the rest.
    async prune() {
      await pool.query(`delete from repo_pulse_events where kind = 'commit' and occurred_at < now() - interval '60 days'`)
      await pool.query(`delete from repo_pulse_star_hours where hour < now() - interval '14 days'`)
    },
  }
}

// excluded: repositories never read, as a Set or a function returning one per run (the worker passes the do-not-promote
// list with maintainer opt-outs; when that read fails the run fails and nothing is read).
export function createDevPulseCollector({ pool, store = createPulseStore(pool), fetchImpl = fetch, now = () => Date.now(),
  headers = () => githubApiHeaders('repo.ing-dev-pulse', fetchImpl), excluded = new Set(), batch = 12 } = {}) {
  let pausedUntil = 0, lastPrune = 0, warnedMissing = false

  async function github(path, etag = null, accept = null) {
    const base = await headers()
    const response = await fetchImpl(`${API}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { ...base, ...(accept ? { Accept: accept } : {}), ...(etag ? { 'If-None-Match': etag } : {}) } })
    const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? Number.POSITIVE_INFINITY)
    if ([403, 429].includes(response.status) || remaining < RATE_FLOOR)
      pausedUntil = Math.max(pausedUntil, now() + MINUTE, Number(response.headers.get('x-ratelimit-reset') || 0) * 1000,
        now() + Number(response.headers.get('retry-after') || 0) * 1000)
    if (response.status === 304) { await response.body?.cancel(); return { notModified: true } }
    if ([404, 410, 451].includes(response.status)) { await response.body?.cancel(); return { missing: true } }
    if (!response.ok) { await response.body?.cancel(); throw Error(`GITHUB_HTTP_${response.status}`) }
    return { data: await response.json(), etag: response.headers.get('etag') }
  }

  async function hackerNews(fullName) {
    const url = `https://hn.algolia.com/api/v1/search?tags=story&restrictSearchableAttributes=url&hitsPerPage=20&query=${encodeURIComponent(`github.com/${fullName}`)}`
    const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'repo.ing-dev-pulse', Accept: 'application/json' } })
    if (!response.ok) { await response.body?.cancel(); throw Error(`HN_HTTP_${response.status}`) }
    return hnEvents((await response.json())?.hits, fullName)
  }

  async function check(row) {
    assertGithubRepoId(row.repoId)
    const time = now(), etags = { ...row.etags }, events = []
    const state = { fullName: row.knownName ?? row.fullName, defaultBranch: row.defaultBranch, stars: row.stars, pushedAt: row.pushedAt,
      activityReadFor: row.activityReadFor, etags, hnCheckedAt: row.hnCheckedAt, checkedAt: iso(time), nextCheckAt: null, error: null }
    // /repositories/{id} survives renames and transfers; the current full name addresses the other reads. While the stored
    // creation time is unknown (repositories saved before migration 0045), it is read once without the validator.
    const repo = await github(`/repositories/${row.repoId}`, row.needsCreatedAt ? null : etags.repo)
    if (repo.missing) return { events, starHours: [], state: { ...state, error: 'REPOSITORY_UNAVAILABLE', nextCheckAt: iso(time + DAY) } }
    let repository = null
    if (repo.data) {
      etags.repo = repo.etag
      const stars = repo.data.stargazers_count, forks = repo.data.forks_count
      if (typeof repo.data.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.data.full_name) || !Number.isSafeInteger(stars)) throw Error('GITHUB_INVALID_REPOSITORY')
      events.push(...milestoneEvents(row.stars, stars, iso(time), repo.data.full_name))
      Object.assign(state, { fullName: repo.data.full_name, defaultBranch: repo.data.default_branch ?? null, stars, pushedAt: repo.data.pushed_at ?? null })
      repository = { stars, forks: Number.isSafeInteger(forks) && forks >= 0 ? forks : null, createdAt: githubTime(repo.data.created_at)?.toISOString() ?? null }
    }
    const name = state.fullName
    const releases = await github(`/repos/${name}/releases?per_page=10`, etags.releases)
    if (releases.data) { etags.releases = releases.etag; events.push(...releaseEvents(releases.data)) }
    // A merged pull request or any push moves pushed_at; until it moves, commits and merges cannot have changed.
    if (state.defaultBranch && (!state.activityReadFor || Date.parse(state.pushedAt) !== Date.parse(state.activityReadFor))) {
      const since = pulseWindowStart(time)
      const commitsPath = `/repos/${name}/commits?sha=${encodeURIComponent(state.defaultBranch)}&since=${iso(since)}&per_page=${COMMIT_PAGE}`
      const seenWindow = etags.commits?.path === commitsPath
      const commits = await github(commitsPath, seenWindow ? etags.commits.etag : null)
      if (commits.data) {
        etags.commits = { path: commitsPath, etag: commits.etag }
        let list = commits.data
        // The first read of a day's window pages back, so a busy repository's 14 days are complete from day one;
        // later reads only need the newest page (checks are minutes apart).
        for (let page = 2; !seenWindow && list.length === (page - 1) * COMMIT_PAGE && page <= MAX_COMMIT_PAGES; page++) {
          const more = await github(`${commitsPath}&page=${page}`)
          if (!Array.isArray(more.data)) break
          list = list.concat(more.data)
        }
        events.push(...commitEvents(list))
      }
      const pulls = await github(`/repos/${name}/pulls?state=closed&sort=updated&direction=desc&per_page=30`, etags.pulls)
      if (pulls.data) { etags.pulls = pulls.etag; events.push(...mergeEvents(pulls.data, since)) }
      state.activityReadFor = state.pushedAt
    }
    // One star snapshot per UTC hour (the latest reading wins); a 304 still records the known total for this hour.
    const hours = Number.isSafeInteger(state.stars) ? [{ hour: iso(hourStart(time)), starsTotal: state.stars }] : []
    const spike = starSpikeEvent(row.starsBefore, state.stars, time)
    if (spike) events.push(spike)
    if (!state.hnCheckedAt || time - Date.parse(state.hnCheckedAt) >= HN_EVERY) {
      try { events.push(...await hackerNews(name)); state.hnCheckedAt = iso(time) } catch { /* Hacker News is optional; retry next check. */ }
    }
    state.nextCheckAt = iso(time + nextCheckDelay(state.pushedAt, time))
    // One upsert cannot touch the same row twice; the last reading of an event wins.
    const unique = [...new Map(events.map(event => [`${event.kind}:${event.sourceId}`, event])).values()]
    return { events: unique, starHours: hours, state, repository }
  }

  return {
    async runOnce() {
      if (pausedUntil > now()) return { paused: iso(pausedUntil) }
      const skip = typeof excluded === 'function' ? await excluded() : excluded
      let due
      try { due = await store.due(batch, skip) } catch (error) {
        if (error?.code !== '42P01') throw error
        if (!warnedMissing) { warnedMissing = true; console.log('dev pulse tables missing; skipping') }
        return { skipped: 'NOT_MIGRATED' }
      }
      const result = { checked: 0, events: 0, errors: 0 }
      for (const row of due) {
        if (pausedUntil > now()) { result.paused = iso(pausedUntil); break }
        try {
          const outcome = await check(row)
          await store.save(row.repoId, outcome)
          result.checked++; result.events += outcome.events.length
        } catch (error) {
          result.errors++
          await store.fail(row.repoId, error?.message ?? 'DEV_PULSE_FAILED', iso(now() + 30 * MINUTE)).catch(() => {})
        }
      }
      if (now() - lastPrune >= HOUR) { await store.prune(); lastPrune = now() }
      return result
    },
  }
}
