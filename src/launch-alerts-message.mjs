// Text of a "new market launched" alert (see src/launch-alerts.mjs). Short and factual: repository, ticker, stars,
// a one-line description and the token page link. Repository text is untrusted: descriptions lose control and bidi
// characters, links, and @/#/$ prefixes (no tagging people, hashtag or cashtag spam), and are truncated to fit.

export const X_MAX_WEIGHT = 280
// X counts every link as 23 characters, whatever its length.
const X_URL_WEIGHT = 23
const TELEGRAM_DESCRIPTION_CHARS = 200
const X_DESCRIPTION_CHARS = 120
const TAGLINE = "Every trade pays the repo's builders."

// C0/C1 controls, zero-width characters, bidi embeddings/overrides/isolates and the BOM.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/gu
const LINKS = /\b(?:https?:\/\/|www\.)\S*/giu
// @mention, #hashtag and $cashtag prefixes (ASCII and full-width), wherever they start a word.
const TAG_PREFIXES = /[@#$＠＃＄]+(?=[\p{L}\p{N}_])/gu
// Anything X may auto-link, counted conservatively (e.g. "next.js" is treated as a link too).
const LINKABLE = /(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:\/\S*)?/gu

export function cleanDescription(value) {
  if (typeof value !== 'string') return ''
  return value.replace(INVISIBLE, ' ').replace(LINKS, ' ').replace(TAG_PREFIXES, '').replace(/\s+/gu, ' ').trim()
}

export const cleanRepoName = value => String(value ?? '').replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 140)
export const cleanSymbol = value => String(value ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16)

export function formatStars(stars) {
  const n = Math.max(0, Math.floor(Number(stars) || 0))
  if (n < 1000) return String(n)
  const [value, unit] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'M']
  return `${(Math.floor(value * 10) / 10).toFixed(1).replace(/\.0$/, '')}${unit}`
}

export const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// twitter-text weighting: these code point ranges count 1, everything else (CJK, emoji, …) counts 2.
const LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]]
const codePointWeight = cp => LIGHT.some(([low, high]) => cp >= low && cp <= high) ? 1 : 2
export function xWeight(text) {
  // An explicit http(s) link always counts 23. Anything else that looks linkable counts at least 23, so text X
  // does not actually link is never undercounted.
  const linked = text.replace(LINKABLE, match => /^https?:\/\//i.test(match) || match.length < X_URL_WEIGHT ? 'x'.repeat(X_URL_WEIGHT) : match)
  let weight = 0
  for (const char of linked) weight += codePointWeight(char.codePointAt(0))
  return weight
}

const graphemes = text => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(part => part.segment)
// Longest grapheme prefix (plus an ellipsis when cut) whose `fits` check passes.
export function truncate(text, fits) {
  if (fits(text)) return text
  const parts = graphemes(text)
  for (let end = parts.length - 1; end > 0; end--) {
    const candidate = `${parts.slice(0, end).join('').trimEnd()}…`
    if (fits(candidate)) return candidate
  }
  return ''
}

export const tokenUrl = (origin, mint) => `${origin}/token/${encodeURIComponent(mint)}`

function lines({ repo, symbol, stars, description, url }) {
  return [`🚀 New on repo.ing: ${repo}${symbol ? ` — $${symbol}` : ''}`, `⭐ ${stars}${description ? ` · ${description}` : ''}`, TAGLINE, url]
}

// market: { fullName, tokenSymbol, stars, description, mint }. channel: 'telegram' (HTML) or 'x' (plain, ≤ 280 weighted).
export function buildLaunchMessage(market, { channel, origin }) {
  const base = { repo: cleanRepoName(market.fullName), symbol: cleanSymbol(market.tokenSymbol), stars: formatStars(market.stars), url: tokenUrl(origin, market.mint) }
  const description = cleanDescription(market.description)
  if (channel === 'telegram') {
    const short = truncate(description, text => [...text].length <= TELEGRAM_DESCRIPTION_CHARS)
    return lines({ ...base, repo: escapeHtml(base.repo), description: escapeHtml(short), url: escapeHtml(base.url) }).join('\n')
  }
  if (channel !== 'x') throw Error(`Unknown launch alert channel ${channel}`)
  const fits = text => [...text].length <= X_DESCRIPTION_CHARS && xWeight(lines({ ...base, description: text }).join('\n')) <= X_MAX_WEIGHT
  const text = lines({ ...base, description: truncate(description, fits) }).join('\n')
  if (xWeight(text) > X_MAX_WEIGHT) throw Error('Launch alert exceeds the X length limit')
  return text
}
