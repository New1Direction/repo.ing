// Text of a "new market launched" alert (see src/launch-alerts.mjs). Short and factual: repository, ticker, stars,
// a one-line description and the token page link. Repository text is untrusted: descriptions lose control and bidi
// characters, links, and @/#/$ prefixes (no tagging people, hashtag or cashtag spam), and are truncated to fit.
// Hugging Face model markets get their own copy (bottom of this file), cleaned the same way.
import { HF_DISCLAIMER_SHORT } from './hf-copy.mjs'
import { isMarketId, marketSource } from './market-identity.mjs'

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
  if (isModelAlert(market)) return buildModelLaunchMessage(market, { channel, origin })
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

// ---------- Hugging Face model markets ----------
// A model market's posts name the model by its Hub id and always carry the short disclaimer every model surface does
// (src/hf-copy.mjs). Text only, as on the site: never a Hugging Face logo or emoji.
export const MODEL_LABEL = 'Hugging Face model'
const MODEL_TAGLINE = "Every trade pays the model's owner."

// The id decides the source, as on every model surface (src/market-identity.mjs): a model market's id is its
// hf_models.market_ref, kept in github_repo_id. Rows without a usable id fall back to their source column.
export function isModelAlert(market) {
  const id = market?.githubRepoId
  if (id !== undefined && id !== null && isMarketId(String(id))) return marketSource(String(id)) === 'huggingface'
  return market?.source === 'huggingface'
}

// The characters cleanRepoName keeps. A model id runs to 193 characters (96 + 1 + 96), so it is not cut to a repository's
// 140: an X post too short for it shortens it visibly (…), never silently into a different model's id.
export const cleanModelPath = value => String(value ?? '').replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 193)

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const counted = (n, word) => `${formatStars(n)} ${word}${n === 1 ? '' : 's'}`
// Likes, else 30-day downloads (live and display only, when the Hub answered for this model), then the parts of the
// stored summary (task · license · base model; src/hf-launch.mjs modelDescription), cleaned like a repository description.
function modelFacts(market) {
  const likes = count(market.likes), downloads = count(market.downloads30d)
  const metric = likes !== null ? `❤️ ${counted(likes, 'like')}` : downloads !== null ? `⬇️ ${counted(downloads, 'download')} (30d)` : null
  return [metric, ...cleanDescription(market.description).split(' · ')].filter(Boolean)
}

function modelLines({ path, symbol, facts, tagline, url }) {
  return [`🚀 New on repo.ing: ${MODEL_LABEL} ${path}${symbol ? ` — $${symbol}` : ''}`, ...(facts ? [facts] : []), ...(tagline ? [tagline] : []),
    HF_DISCLAIMER_SHORT, url]
}

// market: a launch candidate of a model market, plus { likes, downloads30d } when its live card was read.
function buildModelLaunchMessage(market, { channel, origin }) {
  const base = { path: cleanModelPath(market.modelPath || market.fullName), symbol: cleanSymbol(market.tokenSymbol), url: tokenUrl(origin, market.mint) }
  const facts = modelFacts(market)
  if (channel === 'telegram') {
    const line = truncate(facts.join(' · '), text => [...text].length <= TELEGRAM_DESCRIPTION_CHARS)
    return modelLines({ ...base, path: escapeHtml(base.path), facts: escapeHtml(line), tagline: MODEL_TAGLINE, url: escapeHtml(base.url) }).join('\n')
  }
  if (channel !== 'x') throw Error(`Unknown launch alert channel ${channel}`)
  // The disclaimer leaves little room: as many whole facts as fit, then the same without the tagline; a model id too
  // long for even that is shortened visibly. Never a cut fact, never the disclaimer or the link.
  const fits = lines => xWeight(lines.join('\n')) <= X_MAX_WEIGHT
  for (const tagline of [MODEL_TAGLINE, null]) {
    if (!fits(modelLines({ ...base, tagline }))) continue
    let shown = 0
    while (shown < facts.length && fits(modelLines({ ...base, tagline, facts: facts.slice(0, shown + 1).join(' · ') }))) shown++
    return modelLines({ ...base, tagline, facts: facts.slice(0, shown).join(' · ') }).join('\n')
  }
  const path = truncate(base.path, candidate => fits(modelLines({ ...base, path: candidate })))
  if (!path) throw Error('Launch alert exceeds the X length limit')
  return modelLines({ ...base, path }).join('\n')
}
