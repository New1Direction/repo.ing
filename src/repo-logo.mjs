const IMAGE_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'repository-images.githubusercontent.com'])
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|svg|avif)(?:$|\?)/i
const BADGE_OR_SCREENSHOT = /badge|shields?|workflow|build.status|coverage|screenshot|screen.?shot|preview|demo|terminal|banner|hero|cover|sponsors?/i
const LOGO_HINT = /logo|mascot|icon|brand|wordmark|emblem/i

export function repositoryLogoFromReadme(markdown, downloadUrl, repoName) {
  return repositoryImagesFromReadme(markdown, downloadUrl, repoName)[0]?.url ?? null
}

export function repositoryImagesFromReadme(markdown, downloadUrl, repoName) {
  if (typeof markdown !== 'string' || typeof downloadUrl !== 'string') return []
  const candidates = []
  const add = (raw, alt = '') => {
    if (!raw || BADGE_OR_SCREENSHOT.test(`${raw} ${alt}`)) return
    let url
    try { url = new URL(raw.replace(/^<|>$/g, ''), downloadUrl) } catch { return }
    if (!safeGithubImageUrl(url.href) || !IMAGE_HOSTS.has(url.hostname) || !IMAGE_FILE.test(url.pathname)) return
    const hint = `${url.pathname.split('/').pop()} ${alt}`
    const score = (LOGO_HINT.test(hint) ? 10 : 0) + (repoName && hint.toLowerCase().includes(repoName.toLowerCase()) ? 2 : 0)
    if (score > 0 && !candidates.some(item => item.url === url.href)) candidates.push({ url: url.href, score, label: LOGO_HINT.test(hint) ? 'Project logo' : 'README image' })
  }
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\((<?[^\s)]+>?)/g)) add(match[2], match[1])
  for (const match of markdown.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[0])?.[1]
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1]
    add(src, alt)
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, 6)
}

export function repositoryAssetDirectory(imageUrl, readme) {
  if (!readme?.download_url || !readme?.path || !imageUrl) return null
  try {
    const prefix = readme.download_url.slice(0, -readme.path.length)
    if (!imageUrl.startsWith(prefix)) return null
    const relativePath = decodeURIComponent(new URL(imageUrl).pathname.slice(new URL(prefix).pathname.length))
    const slash = relativePath.lastIndexOf('/')
    return slash > 0 && !relativePath.split('/').includes('..') ? relativePath.slice(0, slash) : null
  } catch { return null }
}

export function repositoryLogoFromAssets(entries) {
  return repositoryImagesFromAssets(entries)[0]?.url ?? null
}

export function repositoryImagesFromAssets(entries) {
  if (!Array.isArray(entries)) return []
  const candidates = entries.flatMap(entry => {
    const name = entry.name?.toLowerCase() ?? ''
    const url = safeGithubImageUrl(entry.download_url)
    if (entry.type !== 'file' || !url || !IMAGE_FILE.test(name) || BADGE_OR_SCREENSHOT.test(name) ||
      /lockup|wordmark/i.test(name) || !/(?:^|[-_.])(?:logo|icon|mascot|mark)(?:[-_.]|$)/i.test(name)) return []
    const score = (/(?:^|[-_.])(?:mark|icon|mascot)(?:[-_.]|$)/i.test(name) ? 20 : 0) +
      (/(?:^|[-_.])logo(?:[-_.]|$)/i.test(name) ? 10 : 0) -
      (/(?:^|[-_.])(?:ink|mono|outline|dark)(?:[-_.]|$)/i.test(name) ? 5 : 0) +
      (/\.png$/i.test(name) ? 3 : 0)
    return [{ url, score, label: 'Project logo' }]
  })
  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, 6)
}

export function safeGithubImageUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      value.length <= 2048 && (IMAGE_HOSTS.has(url.hostname) || url.hostname === 'avatars.githubusercontent.com') ? url.href : null
  } catch { return null }
}
