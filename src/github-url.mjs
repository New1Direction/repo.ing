// Dependency-free so client components can parse repo URLs without bundling GitHub App auth (node:crypto).
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
