// Coin profile for owner-approved launches: the description and links a creator adds when requesting a launch, plus
// the metadata repo.ing serves for the coin (its image is stored next to it). Pure (no node: APIs): the launch form
// and the server normalize what people type the same way. The stored values are what this module returns.
export const COIN_DESCRIPTION_MAX = 280

const bytes = value => new TextEncoder().encode(value).length
const clean = value => String(value ?? '').trim()
// C0/C1 controls and bidirectional overrides: shown anywhere (a wallet, the owner's terminal) they can disguise text.
export const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/

// '@name', 'name' or a link on one of `hosts` with exactly one path part. Returns the bare handle, or null when empty.
function handle(value, { hosts, pattern, error }) {
  let text = clean(value)
  if (!text) return null
  if (text.startsWith('@')) text = text.slice(1)
  else if (/[./]/.test(text)) {
    let url
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`) } catch { throw Error(error) }
    const parts = url.pathname.split('/').filter(Boolean)
    if (!hosts.includes(url.hostname.toLowerCase().replace(/^www\./, '')) || parts.length !== 1) throw Error(error)
    text = parts[0]
  }
  if (!pattern.test(text)) throw Error(error)
  return text
}

export const xHandle = value => handle(value, { hosts: ['x.com', 'twitter.com'], pattern: /^[A-Za-z0-9_]{1,15}$/,
  error: 'Enter your X account as @name or an x.com link.' })
export const telegramHandle = value => handle(value, { hosts: ['t.me', 'telegram.me'], pattern: /^[A-Za-z][A-Za-z0-9_]{4,31}$/,
  error: 'Enter a public Telegram group or channel as @name or a t.me link.' })

// A public https address; 'my-coin.xyz' becomes 'https://my-coin.xyz/'. Returns null when empty.
export function websiteUrl(value) {
  const text = clean(value)
  if (!text) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https:\/\//i.test(text)) throw Error('Use an https website address.')
  let url
  try { url = new URL(/^https:\/\//i.test(text) ? text : `https://${text}`) } catch { throw Error('Enter a valid website address, like my-coin.xyz.') }
  if (url.username || url.password || url.port || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) throw Error('Enter a public website address, like my-coin.xyz.')
  if (bytes(url.href) > 200) throw Error('Use a shorter website address (up to 200 characters).')
  return url.href
}

// What the server stores for a request. Throws the first problem as a plain-words Error.
export function coinProfileFields({ description = '', x = '', website = '', telegram = '' } = {}) {
  // One line: whitespace runs (newlines included) become one space, and unsafe characters are dropped.
  const text = String(description ?? '').replace(/[\s\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]+/g, ' ').trim()
  if ([...text].length > COIN_DESCRIPTION_MAX) throw Error(`Keep the description to ${COIN_DESCRIPTION_MAX} characters.`)
  return { description: text, x: xHandle(x), website: websiteUrl(website), telegram: telegramHandle(telegram) }
}

export const coinLinks = ({ x, website, telegram }) => ({ ...(x && { x: `https://x.com/${x}` }), ...(website && { website }),
  ...(telegram && { telegram: `https://t.me/${telegram}` }) })

const coinBase = (origin, id) => `${origin}/api/hook-lab/coins/${id}`
// Canonical UUID bytes, without padding. Kept browser-safe because the form imports this module.
const canonicalUuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
export function coinMetadataAlias(id) {
  if (typeof id !== 'string' || !canonicalUuid.test(id)) throw Error('Invalid canonical coin ID')
  return btoa(id.replaceAll('-', '').match(/../g).map(hex => String.fromCharCode(parseInt(hex, 16))).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
export function coinMetadataId(alias) {
  if (typeof alias !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(alias)) throw Error('Invalid coin metadata alias')
  const hex = [...atob(alias.replaceAll('-', '+').replaceAll('_', '/') + '==')]
    .map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
  if (coinMetadataAlias(id) !== alias) throw Error('Invalid coin metadata alias')
  return id
}
export const selectedCoinMetadataUri = (origin, id) => `${origin}/h/${coinMetadataAlias(id)}`
// The on-chain uri an owner-approved coin launches with: fixed when the request is queued, so approval binds it.
export const coinMetadataUri = (origin, id) => `${coinBase(origin, id)}/metadata`
export const coinImageUrl = (origin, id, width = null) => `${coinBase(origin, id)}/image${width ? `?w=${width}` : ''}`

// Metaplex-style JSON, as repo.ing serves it for repository tokens (app/lib/token-metadata.mjs).
export function coinMetadataJson({ origin, request: { id, name, symbol }, profile }) {
  const links = coinLinks(profile)
  const extensions = { ...(links.website && { website: links.website }), ...(links.x && { twitter: links.x }), ...(links.telegram && { telegram: links.telegram }) }
  return { name, symbol, description: profile.description || `$${symbol} launched on repo.ing.`, image: coinImageUrl(origin, id),
    ...(links.website && { external_url: links.website }), ...extensions, extensions }
}
