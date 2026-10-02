import { githubApiHeaders } from '../../src/github-app-auth.mjs'
import { repositoryAssetDirectory, repositoryImagesFromAssets, repositoryImagesFromReadme, safeGithubImageUrl } from '../../src/repo-logo.mjs'
import { fetchGithubImage, normalizeTokenImage, readLimitedBody } from '../../src/token-image.mjs'
import { assertGithubRepoId } from '../../src/market-identity.mjs'

const cache = new Map(), pending = new Map()
export async function repositoryImageSuggestions(repoId, record) {
  assertGithubRepoId(repoId)
  const key = `${repoId}:${record.owner}/${record.name}:${record.avatar_url}`
  const cached = cache.get(key)
  if (cached?.expiresAt > Date.now()) return cached.result
  if (pending.has(key)) return pending.get(key)
  if (pending.size >= 8) throw Error('Image suggestions are busy. Please try again.')
  const job = (async () => {
    let candidates = []
    try {
      const headers = await githubApiHeaders('repo.ing-image-suggestions')
      const base = `https://api.github.com/repos/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}`
      const response = await fetch(`${base}/readme`, { headers, cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        const readme = JSON.parse((await readLimitedBody(response, 1_000_000)).toString('utf8'))
        if (readme.encoding === 'base64' && readme.size <= 256_000) {
          candidates = repositoryImagesFromReadme(Buffer.from(readme.content, 'base64').toString('utf8'), readme.download_url, record.name)
          const directory = repositoryAssetDirectory(candidates[0]?.url, readme)
          if (directory) {
            const assets = await fetch(`${base}/contents/${directory.split('/').map(encodeURIComponent).join('/')}`, {
              headers, cache: 'no-store', signal: AbortSignal.timeout(5000) })
            if (assets.ok) candidates = [...repositoryImagesFromAssets(JSON.parse((await readLimitedBody(assets, 1_000_000)).toString('utf8'))), ...candidates]
          }
        }
      }
    } catch { /* Public README suggestions are optional; owner avatar and upload remain available. */ }
    // A PNG and SVG of the same mark should not occupy two suggestion slots.
    const unique = new Map()
    for (const item of candidates) {
      const key = item.url.replace(/\.(?:png|jpe?g|webp|gif|svg|avif)(?:\?.*)?$/i, '')
      if (!unique.has(key)) unique.set(key, item)
    }
    candidates = [...unique.values()].slice(0, 3)
    const avatar = safeGithubImageUrl(record.avatar_url)
    if (avatar && !candidates.some(item => item.url === avatar)) candidates.push({ url: avatar, label: 'Owner avatar', score: -10 })
    const images = await Promise.all(candidates.map(async candidate => {
      try {
        const normalized = await normalizeTokenImage(await fetchGithubImage(candidate.url), { allowSvg: true })
        return { image: normalized.image, label: candidate.label, source: candidate.url,
          score: candidate.score + (normalized.width / normalized.height > 2.5 || normalized.height / normalized.width > 2.5 ? -15 : 0) }
      } catch { return null }
    }))
    const result = [...new Map(images.filter(Boolean).sort((a, b) => b.score - a.score).map(item => [item.image, item])).values()]
      .map(({ score, ...item }) => item)
    if (cache.size >= 32) cache.delete(cache.keys().next().value)
    cache.set(key, { result, expiresAt: Date.now() + (result.length ? 10 : 1) * 60_000 })
    return result
  })()
  pending.set(key, job)
  try { return await job } finally { pending.delete(key) }
}
