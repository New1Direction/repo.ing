import { githubApiHeaders } from './github-app-auth.mjs'
import { assertGithubRepoId, isGithubRepoId } from './market-identity.mjs'

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
  assertGithubRepoId(id)
  const response = await fetchImpl(`https://api.github.com/repositories/${id}`, {
    headers: await githubApiHeaders('repo.ing-image-picker', fetchImpl),
    redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(10000),
  })
  const repo = await publicRepositoryFromResponse(response)
  if (repo.githubRepoId.toString() !== String(id)) throw new RepositoryResolutionError('Repository identity mismatch')
  return repo
}

// The owner GitHub reports right now for a repository id: { ownerId, ownerType }, the identity a stock pair is offered by
// (src/quote-assets.mjs). Always a live read by immutable id; a missing or malformed owner id is refused, never guessed.
export async function resolveRepositoryOwner(id, fetchImpl = fetch) {
  if (!/^[1-9]\d{0,18}$/.test(String(id))) throw new RepositoryResolutionError('Invalid repository')
  assertGithubRepoId(id)
  const response = await fetchImpl(`https://api.github.com/repositories/${id}`, {
    headers: await githubApiHeaders('repo.ing-launch-coordinator', fetchImpl),
    redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(10000),
  })
  const repo = await publicRepositoryJson(response)
  if (String(repo.id) !== String(id)) throw new RepositoryResolutionError('Repository identity mismatch')
  if (repo.private || repo.visibility && repo.visibility !== 'public') throw new RepositoryResolutionError('Private repositories are unsupported')
  if (!Number.isSafeInteger(repo.owner?.id) || repo.owner.id < 1 || typeof repo.owner.type !== 'string') {
    throw new RepositoryResolutionError('GitHub returned incomplete owner identity')
  }
  return { ownerId: String(repo.owner.id), ownerType: repo.owner.type }
}

// A GitHub timestamp string as a Date, or null when missing or malformed.
export function githubTime(value) {
  const time = typeof value === 'string' ? new Date(value) : null
  return time && !Number.isNaN(time.getTime()) ? time : null
}

async function publicRepositoryJson(response) {
  if (response.status === 404) throw new RepositoryResolutionError('Repository not found or not public')
  if (!response.ok) throw new RepositoryResolutionError(`GitHub lookup failed: HTTP ${response.status}`)
  return response.json()
}

async function publicRepositoryFromResponse(response) {
  const repo = await publicRepositoryJson(response)
  if (!Number.isSafeInteger(repo.id) || repo.id < 1 || typeof repo.full_name !== 'string' || typeof repo.owner?.login !== 'string') {
    throw new RepositoryResolutionError('GitHub returned incomplete repository identity')
  }
  // Launches and lookups by URL learn the id from this response; one in the Hugging Face range would collide with a model market.
  if (!isGithubRepoId(repo.id)) throw new RepositoryResolutionError('GitHub returned an unsupported repository ID')
  if (repo.private || repo.visibility && repo.visibility !== 'public') throw new RepositoryResolutionError('Private repositories are unsupported')
  if (repo.archived) throw new RepositoryResolutionError('Archived repositories are unsupported')
  const updated = new Date(repo.updated_at)
  if (Number.isNaN(updated.getTime())) throw new RepositoryResolutionError('GitHub returned an invalid update time')
  // Left out (never stored as null over a known value) if GitHub omits it; quality signals then judge by stars alone.
  const created = githubTime(repo.created_at)
  return {
    githubRepoId: BigInt(repo.id), owner: repo.owner.login, name: repo.name,
    fullName: repo.full_name, description: repo.description ?? null,
    avatarUrl: repo.owner.avatar_url ?? null, stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0, archived: Boolean(repo.archived), githubUpdatedAt: updated,
    ...created ? { githubCreatedAt: created } : {},
  }
}
