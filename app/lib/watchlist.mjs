export const WATCHLIST_KEY = 'repo.ing.watchlist.v1'
export const MAX_WATCHED = 50
export const emptyWatchlist = () => ({ version: 1, items: [], alertPercent: 0, baselines: {}, notifications: [] })
const validId = value => /^[1-9]\d{0,17}$/.test(value)
const validMint = value => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
const validSqrt = value => typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value)
export function parseWatchlist(raw) {
  try {
    const data = JSON.parse(raw)
    if (data?.version !== 1 || !Array.isArray(data.items)) return emptyWatchlist()
    const seen = new Set()
    const items = data.items.filter(item => {
      if (!item || !validId(item.repoId) || !validMint(item.mint) || typeof item.fullName !== 'string' || seen.has(item.repoId)) return false
      seen.add(item.repoId); return true
    }).slice(0, MAX_WATCHED).map(({ repoId, mint, fullName }) => ({ repoId: String(repoId), mint, fullName: fullName.slice(0, 200) }))
    const ids = new Set(items.map(item => item.repoId))
    const baselines = Object.fromEntries(Object.entries(data.baselines || {}).filter(([id, value]) => ids.has(id) && validSqrt(value)))
    const notifications = (Array.isArray(data.notifications) ? data.notifications : []).filter(n => n && ids.has(n.repoId) &&
      typeof n.id === 'string' && n.id.length <= 150 && typeof n.text === 'string' && n.text.length <= 180 &&
      Number.isFinite(n.at) && typeof n.read === 'boolean').slice(0, 20).map(({ id, repoId, text, at, read }) => ({ id, repoId, text, at, read }))
    return { version: 1, items, alertPercent: [10, 25].includes(data.alertPercent) ? data.alertPercent : 0, baselines, notifications }
  } catch { return emptyWatchlist() }
}
export function toggleWatched(state, market) {
  const existing = state.items.some(item => item.repoId === String(market.repoId))
  if (existing) {
    const baselines = { ...state.baselines }; delete baselines[market.repoId]
    return { ...state, items: state.items.filter(item => item.repoId !== String(market.repoId)), baselines,
      notifications: state.notifications.filter(n => n.repoId !== String(market.repoId)) }
  }
  if (state.items.length >= MAX_WATCHED) throw Error(`Your watchlist is full. Remove a repository before adding another (${MAX_WATCHED} maximum).`)
  const next = parseWatchlist(JSON.stringify({ ...state, items: [...state.items, { repoId: String(market.repoId), mint: market.mint, fullName: market.fullName }] }))
  if (next.items.length !== state.items.length + 1) throw Error('This market could not be added.')
  return next
}
// Compare squared sqrt prices as integers. Small token prices must not be rounded
// to zero, and a notification must never precede the selected threshold.
export function priceChangeBps(previous, current) {
  if (!validSqrt(previous) || !validSqrt(current)) return null
  const before = BigInt(previous) ** 2n, after = BigInt(current) ** 2n
  return (after - before) * 10000n / before
}
export function applyPriceUpdates(state, quotes, now = Date.now()) {
  if (!state.alertPercent) return state
  const baselines = { ...state.baselines }, notifications = [...state.notifications]
  for (const quote of quotes) {
    const item = state.items.find(item => item.repoId === quote.repoId && item.mint === quote.mint)
    if (!item || !validSqrt(quote.sqrtPrice) || typeof quote.event !== 'string' || quote.event.length > 100) continue
    const previous = baselines[item.repoId]
    if (!previous) { baselines[item.repoId] = quote.sqrtPrice; continue }
    const bps = priceChangeBps(previous, quote.sqrtPrice)
    if (bps === null || (bps < 0n ? -bps : bps) < BigInt(state.alertPercent * 100)) continue
    baselines[item.repoId] = quote.sqrtPrice
    const id = `${item.repoId}:${quote.event}`
    if (notifications.some(n => n.id === id)) continue
    const percent = Number(bps < 0n ? -bps : bps) / 100
    const display = percent > 9999 ? 'over 9,999' : percent.toLocaleString('en-US', { maximumFractionDigits: 1 })
    notifications.unshift({ id, repoId: item.repoId, text: `Price ${bps > 0n ? 'up' : 'down'} ${display}% since your previous alert or starting price.`, at: now, read: false })
  }
  return { ...state, baselines, notifications: notifications.slice(0, 20) }
}
