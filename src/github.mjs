import { githubApiHeaders } from './github-app-auth.mjs'

export class RepositoryResolutionError extends Error {}

export function parseRepositoryUrl(input) {
  let url
  try { url = new URL(input) } catch { throw new RepositoryResolutionError('Invalid GitHub repository URL') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new RepositoryResolutionError('Only public github.com repository URLs are supported')
  }
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length !== 2) throw new RepositoryResolutionError('Expected a GitHub owner/repository URL')
  const [owner, rawName] = parts
  const name = rawName.replace(/\.git$/i, '')
  if (![owner, name].every(part => /^[A-Za-z0-9_.-]+$/.test(part)) || owner === '.' || name === '.') {
    throw new RepositoryResolutionError('Invalid GitHub owner or repository name')
  }
  return { owner, name, normalizedUrl: `https://github.com/${owner}/${name}` }
}

export async function resolvePublicRepository(input, fetchImpl = fetch) {
  const { owner, name } = parseRepositoryUrl(input)
  const response = await fetchImpl(`https://api.github.com/repos/${owner}/${name}`, {
    headers: await githubApiHeaders('repo.ing-launch-coordinator', fetchImpl),
    redirect: 'follow', cache: 'no-store',
  })
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
