import { database } from '../../../lib/server.mjs'
import { githubApiHeaders } from '../../../../src/github-app-auth.mjs'
import { repositoryAssetDirectory, repositoryLogoFromAssets, repositoryLogoFromReadme, safeGithubImageUrl } from '../../../../src/repo-logo.mjs'
import { githubImageVariant, githubImageVariantResponse, imageWidthParam } from '../../../../src/token-image.mjs'
import { assertGithubRepoId, isGithubRepoId, isMarketId, marketSource } from '../../../../src/market-identity.mjs'
import { hfMarketsEnabled, hubAvatarUrl } from '../../../lib/hf-markets.mjs'

export const runtime = 'nodejs'
const logoCache = new Map()
const imageResponse = target => new Response(null, { status: 302, headers: { Location: target,
  'Cache-Control': 'public, max-age=3600, s-maxage=3600' } })

// ?w= serves a resized WebP for in-app avatars; without it the redirect stays canonical for token metadata. GitHub
// repositories get their README logo or owner avatar; a Hugging Face model market gets its owner's avatar (modelLogo).
// Any other id is not found, and GitHub is never asked about a model.
export async function GET(request, { params }) {
  const { repo } = await params
  if (/^\d+$/.test(repo) && isMarketId(repo) && marketSource(repo) === 'huggingface') return modelLogo(request, repo)
  if (!/^\d+$/.test(repo) || !isGithubRepoId(repo)) return new Response(null, { status: 404 })
  const width = request ? imageWidthParam(new URL(request.url).searchParams.get('w')) : null
  if (width === undefined) return new Response(null, { status: 400 })
  const target = await logoTarget(repo)
  if (target instanceof Response) return target
  if (!target) return new Response(null, { status: 404 })
  if (!width) return imageResponse(target)
  try { return githubImageVariantResponse(await githubImageVariant(target, width)) }
  catch { return imageResponse(target) }
}

// A logo found in the README is kept for the market's token (repositories.logo_url, drizzle/0064_repository_logos.sql): once
// a repository has a market, the first README or asset-directory image that passes the project-logo rule (src/repo-logo.mjs)
// is stored and served from then on, so a README edit or a GitHub outage never changes the icon wallets, Blinks and link
// previews keep. The owner-avatar fallback is never stored: a market shows it until its README has its own logo, and an
// error or outage only ever produces that fallback. A repository without a market is not pinned (its README may still change
// before launch); whatever is not pinned is re-read after 10 minutes, so a new market is pinned soon after it is prepared.
const PINNED_TTL_MS = 6 * 60 * 60_000, UNPINNED_TTL_MS = 10 * 60_000
const LAUNCHED = "('prepared', 'submitted', 'confirmed', 'ambiguous')"

async function logoTarget(repo) {
  assertGithubRepoId(repo)
  const cached = logoCache.get(repo)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const pool = database()
  if (!pool) return new Response(null, { status: 503 })
  const { rows } = await pool.query(`select r.owner, r.name, r.avatar_url, r.logo_url,
      exists(select 1 from markets m where m.github_repo_id = r.github_repo_id and m.status in ${LAUNCHED}) as launched
    from repositories r where r.github_repo_id = $1`, [repo])
  const record = rows[0]
  if (!record) return null
  const kept = safeGithubImageUrl(record.logo_url)
  if (kept && !await keptLogoGone(kept)) return remember(repo, kept, PINNED_TTL_MS)
  if (kept) {
    console.warn('repo-logo kept image is gone; reading the logo again', { repo })
    await unpinLogo(pool, repo, kept)
  }
  const { url, complete } = await readmeLogo(record)
  const image = safeGithubImageUrl(url)
  if (image && complete && record.launched) {
    const pinned = await pinLogo(pool, repo, image)
    return remember(repo, pinned ?? image, pinned ? PINNED_TTL_MS : UNPINNED_TTL_MS)
  }
  const target = image || safeGithubImageUrl(record.avatar_url)
  return target && remember(repo, target, UNPINNED_TTL_MS)
}

function remember(repo, url, ttl) {
  if (logoCache.size > 1000) logoCache.clear()
  logoCache.set(repo, { url, expiresAt: Date.now() + ttl })
  return url
}

// The repository's own logo from its README, or from the directory of a README lockup. url: null when there is none, the README
// cannot be read, or GitHub is down (the caller then serves the owner avatar and stores nothing). complete: false when the lockup's
// directory could not be read, so the lockup is shown for now but not stored in place of the mark beside it.
async function readmeLogo(record) {
  const project = { owner: record.owner, name: record.name }
  try {
    const headers = await githubApiHeaders('repo.ing-repository-logo')
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}/readme`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return { url: null }
    const readme = await response.json()
    if (readme.encoding !== 'base64' || readme.size > 256_000) return { url: null }
    const image = repositoryLogoFromReadme(Buffer.from(readme.content, 'base64').toString('utf8'), readme.download_url, record.name, record.owner)
    if (!image || !/lockup|wordmark/i.test(new URL(image).pathname.split('/').pop())) return { url: image, complete: true }
    const directory = repositoryAssetDirectory(image, readme)
    if (!directory) return { url: image, complete: true }
    const path = directory.split('/').map(encodeURIComponent).join('/')
    const assets = await fetch(`https://api.github.com/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}/contents/${path}`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(5000),
    })
    if (!assets.ok) return { url: image, complete: assets.status === 404 }
    return { url: repositoryLogoFromAssets(await assets.json(), project) || image, complete: true }
  } catch { return { url: null } }
}

// A kept logo is a branch URL (README images resolve against the README's download_url), so it breaks when the file moves or is
// deleted, the branch is renamed, or the repository goes private. Checked once per PINNED_TTL_MS: only a 404 or 410 from GitHub
// lets it go (the logo is then read again, and the owner avatar shows until a passing logo is found); any other answer, a
// redirect or a network error keeps it, so an outage never unpins a logo.
async function keptLogoGone(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    return response.status === 404 || response.status === 410
  } catch { return false }
}

// Clears the kept logo only if it is still the one found gone, so a logo another request just stored stays.
async function unpinLogo(pool, repo, url) {
  try { await pool.query('update repositories set logo_url = null, logo_pinned_at = null where github_repo_id = $1 and logo_url = $2', [repo, url]) }
  catch (error) { console.error('repo-logo unpin failed', { repo, error: error.message }) }
}

// Stores the logo unless one is already stored, and returns the stored one: the first resolution wins, so two requests that
// read the README at different moments still agree. null when it could not be stored (it is tried again on a later request).
async function pinLogo(pool, repo, url) {
  try {
    const { rows } = await pool.query(`update repositories set logo_url = $2, logo_pinned_at = now()
      where github_repo_id = $1 and logo_url is null returning logo_url`, [repo, url])
    if (rows[0]) return rows[0].logo_url
    const { rows: [stored] } = await pool.query('select logo_url from repositories where github_repo_id = $1', [repo])
    return safeGithubImageUrl(stored?.logo_url)
  } catch (error) {
    console.error('repo-logo pin failed', { repo, error: error.message })
    return null
  }
}

// A Hugging Face model market's logo: its owner's avatar as the launch stored it (repositories.avatar_url), only from the
// Hub's two avatar hosts (hubAvatarUrl, app/lib/hf-markets.mjs), through the same resizing proxy as GitHub images. No GitHub or Hub API call;
// off (not found) unless HF_MARKETS_ENABLED.
async function modelLogo(request, repo) {
  if (!hfMarketsEnabled()) return new Response(null, { status: 404 })
  const width = request ? imageWidthParam(new URL(request.url).searchParams.get('w')) : null
  if (width === undefined) return new Response(null, { status: 400 })
  const key = `hf:${repo}`, cached = logoCache.get(key)
  let target = cached && cached.expiresAt > Date.now() ? cached.url : undefined
  if (target === undefined) {
    const pool = database()
    if (!pool) return new Response(null, { status: 503 })
    try {
      const { rows } = await pool.query("select avatar_url from repositories where github_repo_id = $1 and source = 'huggingface'", [repo])
      target = hubAvatarUrl(rows[0]?.avatar_url)
    } catch { return new Response(null, { status: 503 }) }
    if (logoCache.size > 1000) logoCache.clear()
    logoCache.set(key, { url: target, expiresAt: Date.now() + 10 * 60_000 })
  }
  if (!target) return new Response(null, { status: 404 })
  if (!width) return imageResponse(target)
  try { return githubImageVariantResponse(await githubImageVariant(target, width, { allow: hubAvatarUrl })) }
  catch { return imageResponse(target) }
}
