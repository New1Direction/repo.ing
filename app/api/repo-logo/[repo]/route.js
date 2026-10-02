import { database } from '../../../lib/server.mjs'
import { githubApiHeaders } from '../../../../src/github-app-auth.mjs'
import { repositoryAssetDirectory, repositoryLogoFromAssets, repositoryLogoFromReadme, safeGithubImageUrl } from '../../../../src/repo-logo.mjs'
import { githubImageVariant, githubImageVariantResponse, imageWidthParam } from '../../../../src/token-image.mjs'
import { assertGithubRepoId, isMarketId } from '../../../../src/market-identity.mjs'

export const runtime = 'nodejs'
const logoCache = new Map()
const imageResponse = target => new Response(null, { status: 302, headers: { Location: target,
  'Cache-Control': 'public, max-age=3600, s-maxage=3600' } })

// ?w= serves a resized WebP for in-app avatars; without it the redirect stays canonical for token metadata.
export async function GET(request, { params }) {
  const { repo } = await params
  if (!/^\d+$/.test(repo) || !isMarketId(repo)) return new Response(null, { status: 404 })
  const width = request ? imageWidthParam(new URL(request.url).searchParams.get('w')) : null
  if (width === undefined) return new Response(null, { status: 400 })
  const target = await logoTarget(repo)
  if (target instanceof Response) return target
  if (!target) return new Response(null, { status: 404 })
  if (!width) return imageResponse(target)
  try { return githubImageVariantResponse(await githubImageVariant(target, width)) }
  catch { return imageResponse(target) }
}

async function logoTarget(repo) {
  assertGithubRepoId(repo)
  const cached = logoCache.get(repo)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const pool = database()
  if (!pool) return new Response(null, { status: 503 })
  const { rows } = await pool.query('select owner, name, avatar_url from repositories where github_repo_id = $1', [repo])
  const record = rows[0]
  if (!record) return null
  let image = null
  try {
    const headers = await githubApiHeaders('repo.ing-repository-logo')
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}/readme`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(5000),
    })
    if (response.ok) {
      const readme = await response.json()
      if (readme.encoding === 'base64' && readme.size <= 256_000) {
        image = repositoryLogoFromReadme(Buffer.from(readme.content, 'base64').toString('utf8'), readme.download_url, record.name)
        if (image && /lockup|wordmark/i.test(new URL(image).pathname.split('/').pop())) {
          const directory = repositoryAssetDirectory(image, readme)
          if (directory) {
            const path = directory.split('/').map(encodeURIComponent).join('/')
            const assets = await fetch(`https://api.github.com/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}/contents/${path}`, {
              headers, cache: 'no-store', signal: AbortSignal.timeout(5000),
            })
            if (assets.ok) image = repositoryLogoFromAssets(await assets.json()) || image
          }
        }
      }
    }
  } catch { /* A missing README or GitHub outage falls back to the owner avatar. */ }
  const target = safeGithubImageUrl(image) || safeGithubImageUrl(record.avatar_url)
  if (!target) return null
  if (logoCache.size > 1000) logoCache.clear()
  logoCache.set(repo, { url: target, expiresAt: Date.now() + (image ? 6 * 60 : 10) * 60_000 })
  return target
}
