import { TIP_MIN_USD, TIP_TOKENS, minimumTipBaseUnits } from './tip-tokens.mjs'

// "Parts fund": a verified maintainer lists the hardware parts a build needs; backers pledge USDC or SOL into the
// custodial tip wallet; all-or-nothing at the deadline (paid to the maintainer's payout wallet if the goal is met,
// else refunded to every backer). This module is pure: limits, input validation, USD math and item fill.

export const PARTS_MAX_GOAL_CENTS = 500_000 // $5,000 per list at launch
export const PARTS_GLOBAL_CAP_CENTS = 5_000_000 // $50,000 pledged across every unsettled list
export const PARTS_MIN_PLEDGE_USD = TIP_MIN_USD
export const PARTS_MIN_PLEDGE_CENTS = PARTS_MIN_PLEDGE_USD * 100
export const PARTS_DEFAULT_DAYS = 30, PARTS_MIN_DAYS = 7, PARTS_MAX_DAYS = 60
export const PARTS_MAX_ITEMS = 25
export const PARTS_MAX_QUANTITY = 999
export const PARTS_UPDATE_MAX_CHARS = 1000, PARTS_UPDATE_MAX_IMAGES = 4
// A pledge must be prepared at least this long before the deadline, so it lands (or provably expires) first.
export const PARTS_PLEDGE_CUTOFF_MS = 3 * 60_000
// In-flight (prepared or submitted) pledges one wallet may hold on one list.
export const PARTS_MAX_OPEN_PLEDGES = 2
export const PARTS_DISABLED = 'Parts funds are not enabled'
const DAY_MS = 24 * 60 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const validUuid = id => typeof id === 'string' && UUID.test(id)

export const PARTS_TOKENS = Object.freeze(TIP_TOKENS.filter(t => t.symbol === 'SOL' || t.symbol === 'USDC'))
export function partsToken(mint) {
  const token = PARTS_TOKENS.find(t => t.mint === mint)
  if (!token) throw Error('Parts funds accept USDC or SOL')
  return token
}

// ---------- Text and money input ----------
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/
function text(value, { label, min = 0, max, multiline = false }) {
  if (value === null || value === undefined) value = ''
  if (typeof value !== 'string') throw Error(`Invalid ${label}`)
  const clean = value.replace(/\r\n?/g, '\n').trim()
  if ((!multiline && clean.includes('\n')) || CONTROL.test(clean)) throw Error(`${label[0].toUpperCase()}${label.slice(1)} contains unsupported characters`)
  if ([...clean].length < min) throw Error(min === 1 ? `Enter a ${label}` : `${label[0].toUpperCase()}${label.slice(1)} needs at least ${min} characters`)
  if ([...clean].length > max) throw Error(`${label[0].toUpperCase()}${label.slice(1)} is limited to ${max} characters`)
  return clean
}

// "12", "12.5", "12.50" → 1250. Strings only, so no float ever reaches a stored amount.
export function parseUsdCents(value, label = 'price') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(value.trim())) throw Error(`Enter the ${label} in dollars, like 12.50`)
  const [whole, fraction = ''] = value.trim().split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
export const formatCents = cents => `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: Number(cents) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`

// Purchase links: https only, no credentials or ports. Displayed as plain text domain plus a nofollow link.
export function safePurchaseUrl(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 500) throw Error('Purchase link is too long')
  let url
  try { url = new URL(value.trim()) } catch { throw Error('Purchase link must be a full https:// address') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || url.href.length > 500) {
    throw Error('Purchase link must be a full https:// address')
  }
  return url.href
}
export const linkDomain = href => { try { return new URL(href).hostname.replace(/^www\./, '') } catch { return '' } }

export function validateFundInput(input) {
  if (!input || typeof input !== 'object') throw Error('Invalid parts list')
  const title = text(input.title, { label: 'title', min: 3, max: 100 })
  const description = text(input.description, { label: 'description', max: 1000, multiline: true }) || null
  if (!Array.isArray(input.items) || !input.items.length) throw Error('Add at least one part')
  if (input.items.length > PARTS_MAX_ITEMS) throw Error(`A parts list holds up to ${PARTS_MAX_ITEMS} parts`)
  const items = input.items.map((item, index) => {
    const name = text(item?.name, { label: `part ${index + 1} name`, min: 1, max: 80 })
    const unitPriceCents = parseUsdCents(item?.unitPrice, `price of part ${index + 1}`)
    if (unitPriceCents < 1) throw Error(`Part ${index + 1} needs a price`)
    const quantity = Number(item?.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > PARTS_MAX_QUANTITY) throw Error(`Part ${index + 1} quantity must be 1 to ${PARTS_MAX_QUANTITY}`)
    return Object.freeze({ position: index, name, url: safePurchaseUrl(item?.url), unitPriceCents, quantity })
  })
  const goalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0)
  if (goalCents > PARTS_MAX_GOAL_CENTS) throw Error(`Parts lists are capped at ${formatCents(PARTS_MAX_GOAL_CENTS)} for now`)
  const days = input.durationDays === undefined || input.durationDays === null || input.durationDays === '' ? PARTS_DEFAULT_DAYS : Number(input.durationDays)
  if (!Number.isInteger(days) || days < PARTS_MIN_DAYS || days > PARTS_MAX_DAYS) throw Error(`Deadline must be ${PARTS_MIN_DAYS} to ${PARTS_MAX_DAYS} days away`)
  return Object.freeze({ title, description, items: Object.freeze(items), goalCents, durationDays: days })
}
export const fundDeadline = (days, now = Date.now()) => new Date(now + days * DAY_MS)

// ---------- Build updates ----------
// Images are links on GitHub or Imgur only; the page shows them through /api/parts-fund/image, which re-encodes them.
const UPDATE_IMAGE_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'i.imgur.com'])
const GITHUB_IMAGE_PATH = /^\/(user-attachments\/assets\/[0-9a-f-]{36}|[\w.-]{1,100}\/[\w.-]{1,100}\/raw\/[^?#]{1,400})$/i
export function safeUpdateImageUrl(value) {
  if (typeof value !== 'string' || value.length > 600) throw Error('Image links must be GitHub or Imgur image URLs')
  let url
  try { url = new URL(value.trim()) } catch { throw Error('Image links must be GitHub or Imgur image URLs') }
  const ok = url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (UPDATE_IMAGE_HOSTS.has(url.hostname) || (url.hostname === 'github.com' && GITHUB_IMAGE_PATH.test(url.pathname)))
  if (!ok) throw Error('Image links must be GitHub or Imgur image URLs')
  return url.href
}
// Where an allowed image link may redirect while it is fetched for display (GitHub attachments and raw links).
export const UPDATE_IMAGE_REDIRECT_HOSTS = new Set([...UPDATE_IMAGE_HOSTS, 'private-user-images.githubusercontent.com', 'objects.githubusercontent.com'])

export function validateUpdateInput(input) {
  const body = text(input?.body, { label: 'build update', min: 1, max: PARTS_UPDATE_MAX_CHARS, multiline: true })
  const raw = input?.images ?? []
  if (!Array.isArray(raw) || raw.length > PARTS_UPDATE_MAX_IMAGES) throw Error(`Add up to ${PARTS_UPDATE_MAX_IMAGES} images`)
  const images = [...new Set(raw.filter(v => v !== '').map(safeUpdateImageUrl))]
  return Object.freeze({ body, images: Object.freeze(images) })
}

// ---------- Pledge amounts ----------
// USD value of a pledge at pledge time, in cents (nearest cent). The minimum is enforced in base units first.
export function pledgeUsdCents(token, amount, usdPrice) {
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) throw Error('Token price is unavailable; pledges in this token are paused')
  const cents = Math.round(Number(amount) * usdPrice * 100 / 10 ** token.decimals)
  if (!Number.isSafeInteger(cents) || cents <= 0) throw Error('Invalid pledge amount')
  return cents
}
export function assertPledgeAmount(token, amount, usdPrice) {
  const minimum = minimumTipBaseUnits(token, usdPrice)
  if (amount < minimum) throw Object.assign(Error(`Pledges start at $${PARTS_MIN_PLEDGE_USD}`), { minimum })
  return pledgeUsdCents(token, amount, usdPrice)
}
// Per-list cap: pledged (confirmed + in flight) never passes the goal, except that the last pledge may be the $5
// minimum when less than that is left. `held` = cents already confirmed or in flight on this list.
export function assertPledgeRoom({ goalCents, held, cents, globalHeld = 0 }) {
  const room = Number(goalCents) - Number(held)
  if (room <= 0) throw Error('This parts list is fully pledged')
  if (cents > Math.max(room, PARTS_MIN_PLEDGE_CENTS)) throw Object.assign(Error(`Only ${formatCents(room)} is left to pledge on this list`), { room })
  if (Number(globalHeld) + cents > PARTS_GLOBAL_CAP_CENTS) throw Error('Parts funds are at capacity right now. Try again later.')
  return room
}

// ---------- Progress ----------
// Item fill: earmarked pledges fill their own part first (any excess joins the general pool); the general pool then
// fills every part in proportion to what it still needs (largest remainder, exact cents). A part is funded ✓ once
// filled to its cost: by earmarks, or when the whole list is covered.
export function itemFill(items, pledges) {
  const cost = new Map(items.map(item => [item.id, item.unitPriceCents * item.quantity]))
  const earmarked = new Map(items.map(item => [item.id, 0]))
  let pool = 0
  for (const pledge of pledges) {
    const cents = Number(pledge.usdCents)
    if (pledge.itemId && earmarked.has(pledge.itemId)) earmarked.set(pledge.itemId, earmarked.get(pledge.itemId) + cents)
    else pool += cents
  }
  const filled = new Map()
  for (const item of items) {
    const own = Math.min(earmarked.get(item.id), cost.get(item.id))
    pool += earmarked.get(item.id) - own
    filled.set(item.id, own)
  }
  const need = items.map(item => ({ id: item.id, need: cost.get(item.id) - filled.get(item.id) }))
  const totalNeed = need.reduce((sum, n) => sum + n.need, 0)
  const share = Math.min(pool, totalNeed)
  if (share > 0) {
    const parts = need.map(n => ({ ...n, exact: n.need * share / totalNeed }))
    let given = 0
    for (const p of parts) { p.base = Math.floor(p.exact); given += p.base }
    parts.slice().sort((a, b) => (b.exact - b.base) - (a.exact - a.base)).slice(0, share - given).forEach(p => { p.base += 1 })
    for (const p of parts) filled.set(p.id, filled.get(p.id) + p.base)
  }
  return items.map(item => {
    const itemCost = cost.get(item.id), fill = filled.get(item.id)
    return { id: item.id, costCents: itemCost, earmarkedCents: earmarked.get(item.id), filledCents: fill, funded: fill >= itemCost,
      percent: itemCost ? Math.min(100, Math.floor(fill * 100 / itemCost)) : 0 }
  })
}

export function daysLeft(deadline, now = Date.now()) {
  const ms = new Date(deadline).getTime() - now
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}
export const fundPercent = (pledgedCents, goalCents) => goalCents > 0 ? Math.min(100, Math.floor(Number(pledgedCents) * 100 / Number(goalCents))) : 0
export const pledgeMemo = id => `repoing-parts:${id}`
