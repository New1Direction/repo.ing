// Hugging Face avatar URLs the image proxy may fetch (app/api/repo-logo/[repo]/route.js, model markets): https on the two
// Hub avatar hosts only, avatar paths only, with no credentials, port, query or fragment. Every redirect hop is checked
// again (src/token-image.mjs fetchGithubImage). src/hf-api.mjs keeps the same shapes when it reads an owner's avatar.
export const HF_AVATAR_HOSTS = Object.freeze(['cdn-avatars.huggingface.co', 'huggingface.co'])
const PATHS = new Map([['cdn-avatars.huggingface.co', /^\/v1\/production\/uploads\/[\w./-]+$/], ['huggingface.co', /^\/avatars\/[\w.-]+$/]])

export function safeHfAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  let url
  try { url = new URL(value) } catch { return null }
  const path = PATHS.get(url.hostname)
  if (!path || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !path.test(url.pathname)) return null
  return url.href
}
