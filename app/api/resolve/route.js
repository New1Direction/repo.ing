import { parseRepositoryUrl, resolvePublicRepository } from '../../../src/github.mjs'
import { database } from '../../lib/server.mjs'
export const runtime = 'nodejs'
export async function POST(request) {
  try {
    const { url } = await request.json()
    const normalizedUrl = typeof url === 'string' && url.trim().startsWith('github.com/') ? `https://${url.trim()}` : url
    const { owner, name } = parseRepositoryUrl(normalizedUrl)
    const pool = database()
    if (!pool) return Response.json({ error: 'Database is not configured' }, { status: 503 })
    // Existing finalized markets can be opened without consuming GitHub's shared IP limit.
    const known = await pool.query(`select r.github_repo_id::text as "repoId", m.mint
      from repositories r join markets m on m.github_repo_id = r.github_repo_id
      where lower(r.full_name) = lower($1) and r.archived = false
        and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'
        and r.synced_at > now() - interval '24 hours'`, [`${owner}/${name}`])
    if (known.rows[0]) return Response.json(known.rows[0])
    const repo = await resolvePublicRepository(normalizedUrl)
    await pool.query(`insert into repositories (github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (github_repo_id) do update set
      owner=excluded.owner,name=excluded.name,full_name=excluded.full_name,description=excluded.description,
      avatar_url=excluded.avatar_url,stars=excluded.stars,forks=excluded.forks,archived=excluded.archived,
      github_updated_at=excluded.github_updated_at,synced_at=now()`, [repo.githubRepoId.toString(), repo.owner, repo.name,
      repo.fullName, repo.description, repo.avatarUrl, repo.stars, repo.forks, repo.archived, repo.githubUpdatedAt])
    const { rows } = await pool.query(`select mint from markets where github_repo_id = $1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'`, [repo.githubRepoId.toString()])
    return Response.json({ repoId: repo.githubRepoId.toString(), mint: rows[0]?.mint ?? null })
  } catch (error) { return Response.json({ error: error.message }, { status: 400 }) }
}
