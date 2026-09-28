export async function persistLaunchRepository(pool, repo) {
  await pool.query(`insert into repositories (github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (github_repo_id) do update set
    owner=excluded.owner,name=excluded.name,full_name=excluded.full_name,description=excluded.description,
    avatar_url=excluded.avatar_url,stars=excluded.stars,forks=excluded.forks,archived=excluded.archived,
    github_updated_at=excluded.github_updated_at,synced_at=now()`, [repo.githubRepoId.toString(), repo.owner, repo.name,
    repo.fullName, repo.description, repo.avatarUrl, repo.stars, repo.forks, repo.archived, repo.githubUpdatedAt])
}

