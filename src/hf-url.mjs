// Hugging Face model URLs and ids. Dependency-free so client components can parse them; the API client is src/hf-api.mjs.
// Models only: datasets, Spaces and collections are refused here, before anything reaches the Hub.
export class HfUrlError extends Error { name = 'HfUrlError' }

const HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co'])
// First path segments that are Hub sections rather than an owner. A miss here only means the Hub answers "not found".
const SECTIONS = new Map([['datasets', 'datasets'], ['spaces', 'Spaces'], ['collections', 'collections'], ['buckets', 'buckets'],
  ['kernels', 'kernels'], ['papers', 'papers'], ['posts', 'posts'], ['blog', 'blog posts'], ['docs', 'documentation'],
  ['models', 'model listings'], ['organizations', 'organization pages'], ['settings', 'settings pages'], ['api', 'API URLs']])
// huggingface_hub validate_repo_id: ASCII letters, digits, "_", "-" and "."; starts and ends with a letter, digit or "_";
// no "--" or ".."; at most 96 characters; never ending in ".git". Owners (users and organizations) follow the same rule.
const NAME = /^(?=.{1,96}$)\w(?:[\w.-]*\w)?$/

export function isHfName(value) {
  return typeof value === 'string' && NAME.test(value) && !value.includes('--') && !value.includes('..') && !/\.git$/i.test(value)
}

export function isHfModelPath(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length === 2 && isHfName(parts[0]) && isHfName(parts[1]) && !SECTIONS.has(parts[0].toLowerCase())
}

// https://huggingface.co/{owner}/{name}[/any/trailing/path][?query][#hash], the same on hf.co and www.huggingface.co,
// with or without the https:// prefix, or a bare owner/name. Returns { owner, name, path } with the case as given:
// the Hub matches paths case-insensitively and the API client reports the canonical spelling.
export function parseHfModelUrl(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!text || text.length > 2048) throw new HfUrlError('Enter a Hugging Face model URL or owner/name')
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text)
  let segments
  if (hasScheme || /^(?:www\.)?(?:huggingface|hf)\.co\//i.test(text)) {
    let url
    try { url = new URL(hasScheme ? text : `https://${text}`) } catch { throw new HfUrlError('Invalid Hugging Face URL') }
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) {
      throw new HfUrlError('Only https://huggingface.co model URLs are supported')
    }
    segments = url.pathname.split('/').filter(Boolean)
  } else {
    segments = text.split('/')
    if (segments.length !== 2) throw new HfUrlError('Expected a Hugging Face model as owner/name')
  }
  const section = SECTIONS.get(segments[0]?.toLowerCase())
  if (section) throw new HfUrlError(`Only Hugging Face models are supported, not ${section}`)
  if (segments.length < 2) throw new HfUrlError('Expected a Hugging Face model URL (huggingface.co/owner/name)')
  const [owner, name] = segments
  if (!isHfName(owner) || !isHfName(name)) throw new HfUrlError('Invalid Hugging Face owner or model name')
  return { owner, name, path: `${owner}/${name}` }
}

export function hfModelUrl(path) {
  if (!isHfModelPath(path)) throw new HfUrlError('Invalid Hugging Face model path')
  return `https://huggingface.co/${path}`
}
