const IMAGE_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'repository-images.githubusercontent.com'])
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|svg|avif)(?:$|\?)/i
const BADGE_OR_SCREENSHOT = /badge|shields?|workflow|build.status|coverage|screenshot|screen.?shot|preview|demo|terminal|banner|hero|cover|sponsors?/i
const LOGO_HINT = /logo|mascot|icon|brand|wordmark|emblem/i
// The same hint in alt text, as whole words: "iconic" or "branded" in a sentence is not a logo.
const ALT_LOGO_HINT = /\b(?:logo\w*|mascot|icons?|brand(?:ing)?|wordmark|emblem)\b/i

// The project-logo rule. A README (or asset-directory) image counts as the repository's own logo only when its file name or
// alt text names the repository or its owner, ignoring case, separators (- _ . and spaces) and generic words, or when its
// file name is generic words only ("logo.png", "icon-dark.svg") and its alt text names nothing else. A README that shows
// other projects' logos (a providers or integrations table: "claude.png", alt "Claude logo") names something else, so the
// market keeps the owner's avatar instead. Only an image that passes the rule and looks like a logo (a logo word, or a file
// named after the project) is ever picked automatically; the launch form still offers other README images to a launcher.
const GENERIC_WORDS = new Set(['logo', 'logos', 'logotype', 'logomark', 'icon', 'icons', 'favicon', 'mark', 'symbol', 'glyph', 'emblem',
  'brand', 'branding', 'wordmark', 'lockup', 'mascot', 'avatar', 'image', 'img', 'pic', 'picture', 'text', 'light', 'dark', 'day', 'night',
  'mode', 'theme', 'color', 'colour', 'colored', 'coloured', 'full', 'mono', 'monochrome', 'white', 'black', 'grey', 'gray', 'transparent',
  'bg', 'nobg', 'background', 'inverse', 'inverted', 'invert', 'alt', 'alternate', 'outline', 'outlined', 'filled', 'solid', 'flat', 'ink',
  'square', 'round', 'rounded', 'circle', 'circular', 'small', 'medium', 'large', 'big', 'tiny', 'sm', 'md', 'lg', 'xl', 'xs', 'xxl', 'hd',
  'hq', 'hires', 'retina', 'horizontal', 'vertical', 'stacked', 'primary', 'secondary', 'default', 'main', 'official', 'new', 'old',
  'final', 'original', 'min', 'readme', 'project', 'app', 'png', 'svg', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'ico', 'the', 'a', 'an',
  'of', 'for', 'and', 'our', 'with'])
// Generic words run together ("logolight", "iconwhite"): only words of three letters or more, so "sm" or "a" never splits a name.
const RUN_TOGETHER = new RegExp(`^(?:${[...GENERIC_WORDS].filter(word => word.length >= 3).sort((a, b) => b.length - a.length).join('|')})+$`)
const words = text => String(text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const compact = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const genericWord = word => GENERIC_WORDS.has(word) || /^\d+(?:x\d*)?$/.test(word) || /^v\d+$/.test(word) || RUN_TOGETHER.test(word)
const distinctive = text => words(text).filter(word => !genericWord(word)).join('')
// A name of one or two characters must be a whole word ("ui-logo.png" for a repository named ui, never "guide.png").
const names = (text, name) => name.length >= 3 ? compact(text).includes(name) : words(text).includes(name)
// The brand in shorter form than the slug: a distinctive word of four letters or more that is a whole word of the repository or
// owner name ("Polkadot" for polkadot-sdk, "Reanimated" for react-native-reanimated, "Acme" for acme-inc), or, for a one-word
// repository name, the start of it with five letters or more ("turbo" for turborepo). Another product's name is still no
// match ("Claude" for rynfar/meridian, "opencode" for paperclip).
const shortForm = (text, repoWords, ownerWords) => words(text).filter(word => word.length >= 4 && !genericWord(word)).some(word =>
  repoWords.includes(word) || ownerWords.includes(word) || (repoWords.length === 1 && word.length >= 5 && repoWords[0].startsWith(word)))
const fileStem = fileName => {
  let name = String(fileName ?? '')
  try { name = decodeURIComponent(name) } catch { /* A malformed escape is compared as written. */ }
  return name.replace(/\.[a-z0-9]+$/i, '')
}

// { own, logo }: own when the image passes the project-logo rule; logo when it may also be picked automatically.
export function projectImage({ fileName, alt = '', owner, repo }) {
  const projectNames = [repo, owner].map(compact).filter(Boolean)
  const stem = fileStem(fileName)
  const repoWords = words(repo), ownerWords = words(owner)
  const mentioned = text => projectNames.some(name => names(text, name)) || shortForm(text, repoWords, ownerWords)
  const own = mentioned(stem) || mentioned(alt) || (!distinctive(stem) && !distinctive(alt))
  const named = projectNames.some(name => name === compact(stem) || name === distinctive(stem))
  return { own, logo: own && (named || LOGO_HINT.test(stem) || ALT_LOGO_HINT.test(alt)) }
}

export function repositoryLogoFromReadme(markdown, downloadUrl, repoName, ownerName) {
  return repositoryImagesFromReadme(markdown, downloadUrl, repoName, ownerName).find(item => item.logo)?.url ?? null
}

// README images that could be the project's artwork, best first. logo: the image passes the project-logo rule (projectImage),
// so it may be picked as the market's logo; any other image here is only a choice for a launcher.
export function repositoryImagesFromReadme(markdown, downloadUrl, repoName, ownerName) {
  if (typeof markdown !== 'string' || typeof downloadUrl !== 'string') return []
  const candidates = []
  const add = (raw, alt = '') => {
    if (!raw || BADGE_OR_SCREENSHOT.test(`${raw} ${alt}`)) return
    let url
    try { url = new URL(raw.replace(/^<|>$/g, ''), downloadUrl) } catch { return }
    if (!safeGithubImageUrl(url.href) || !IMAGE_HOSTS.has(url.hostname) || !IMAGE_FILE.test(url.pathname)) return
    const fileName = url.pathname.split('/').pop()
    const hint = `${fileName} ${alt}`
    const project = projectImage({ fileName, alt, owner: ownerName, repo: repoName })
    const mentions = name => name && hint.toLowerCase().includes(name.toLowerCase())
    const score = (project.logo ? 100 : 0) + (LOGO_HINT.test(hint) ? 10 : 0) + (mentions(repoName) ? 2 : 0) + (mentions(ownerName) ? 1 : 0)
    if (score > 0 && !candidates.some(item => item.url === url.href)) {
      candidates.push({ url: url.href, score, label: project.logo ? 'Project logo' : 'README image', logo: project.logo })
    }
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

export function repositoryLogoFromAssets(entries, project) {
  return repositoryImagesFromAssets(entries, project).find(item => item.logo)?.url ?? null
}

// Logo files in the directory of a README lockup. { owner, name }: the repository, for the project-logo rule; a file named
// after another project ("claude-icon.png") is never the logo.
export function repositoryImagesFromAssets(entries, { owner, name: repo } = {}) {
  if (!Array.isArray(entries)) return []
  const candidates = entries.flatMap(entry => {
    const name = entry.name?.toLowerCase() ?? ''
    const url = safeGithubImageUrl(entry.download_url)
    if (entry.type !== 'file' || !url || !IMAGE_FILE.test(name) || BADGE_OR_SCREENSHOT.test(name) ||
      /lockup|wordmark/i.test(name) || !/(?:^|[-_.])(?:logo|icon|mascot|mark)(?:[-_.]|$)/i.test(name)) return []
    const { logo } = projectImage({ fileName: entry.name, owner, repo })
    const score = (logo ? 100 : 0) + (/(?:^|[-_.])(?:mark|icon|mascot)(?:[-_.]|$)/i.test(name) ? 20 : 0) +
      (/(?:^|[-_.])logo(?:[-_.]|$)/i.test(name) ? 10 : 0) -
      (/(?:^|[-_.])(?:ink|mono|outline|dark)(?:[-_.]|$)/i.test(name) ? 5 : 0) +
      (/\.png$/i.test(name) ? 3 : 0)
    return [{ url, score, label: logo ? 'Project logo' : 'Repository image', logo }]
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
