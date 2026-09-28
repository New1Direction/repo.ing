import { githubApiHeaders } from './github-app-auth.mjs'

import { RepositoryResolutionError, parseRepositoryUrl } from './github-url.mjs'
export { RepositoryResolutionError, parseRepositoryUrl }

export async function resolvePublicRepository(input, fetchImpl = fetch) {
  const { owner, name } = parseRepositoryUrl(input)
  const response = await fetchImpl(`https://api.github.com/repos/${owner}/${name}`, {
    headers: await githubApiHeaders('repo.ing-launch-coordinator', fetchImpl),
    redirect: 'follow', cache: 'no-store',
  })
  return publicRepositoryFromResponse(response)
}

// Resolve direct launch links by immutable identity, never by a browser-supplied name.
export async function resolvePublicRepositoryById(id, fetchImpl = fetch) {
  if (!/^[1-9]\d{0,18}$/.test(String(id))) throw new RepositoryResolutionError('Invalid repository')
  const response = await fetchImpl(`https://api.github.com/repositories/${id}`, {
    headers: await githubApiHeaders('repo.ing-image-picker', fetchImpl),
    redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(10000),
  })
  const repo = await publicRepositoryFromResponse(response)
  if (repo.githubRepoId.toString() !== String(id)) throw new RepositoryResolutionError('Repository identity mismatch')
  return repo
}

async function publicRepositoryFromResponse(response) {
  if (response.status === 404) throw new RepositoryResolutionError('Repository not found or not public')
  if (!response.ok) throw new RepositoryResolutionError(`GitHub lookup failed: HTTP ${response.status}`)
  const repo = await response.json()
  if (!Number.isSafeInteger(repo.id) || repo.id < 1 || typeof repo.full_name !== 'string' || typeof repo.owner?.login !== 'string') {
    throw new RepositoryResolutionError('GitHub returned incomplete repository identity')
  }
  if (repo.private || repo.visibility && repo.visibility !== 'public') throw new RepositoryResolutionError('Private repositories are unsupported')
  if (repo.archived) throw new RepositoryResolutionError('Archived repositories are unsupported')
  const updated = new Date(repo.updated_at)
  if (Number.isNaN(updated.getTime())) throw new RepositoryResolutionError('GitHub returned an invalid update time')
  return {
    githubRepoId: BigInt(repo.id), owner: repo.owner.login, name: repo.name,
    fullName: repo.full_name, description: repo.description ?? null,
    avatarUrl: repo.owner.avatar_url ?? null, stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0, archived: Boolean(repo.archived), githubUpdatedAt: updated,
  }
}
