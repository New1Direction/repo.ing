// Client-safe display helpers for the Hooks UI (owner pass, 2026-10-28). Display only: every amount comes from the
// trade panel's estimate (hooklab-trade-math.mjs estimateTrade, the model the server reviews with) or from the market read.

const pct = bps => `${Number(bps) / 100}%`

// One fee number with a plain breakdown: "5% fee: 3% burned, 2% creator". The creator's part is split 75/25 with repo.ing
// in SOL; the burned part is coins destroyed on each trade; holders' part goes to holders (Holders Earn).
export function feeHeadline({ creatorFeeBps = 0, burnBps = 0, holderBps = 0 }) {
  const creator = Number(creatorFeeBps) || 0, burn = Number(burnBps) || 0, holders = Number(holderBps) || 0, totalBps = creator + burn + holders
  if (!totalBps) return { totalBps, text: 'No trading fee' }
  const parts = [burn && `${pct(burn)} burned`, holders && `${pct(holders)} to holders`, creator && `${pct(creator)} creator`].filter(Boolean)
  if (parts.length === 1 && creator) return { totalBps, text: `${pct(totalBps)} fee, all to the creator` }
  return { totalBps, text: `${pct(totalBps)} fee: ${parts.join(', ')}` }
}

// The trade box's pre-sign preview, straight from the estimate: you pay, the fee (SOL), coins burned, you receive and
// the minimum the review enforces. Buy: pay SOL, receive coins. Sell: pay coins, receive SOL.
export function tradePreview(market, estimate, { side, amount }) {
  if (!estimate || estimate.error) return null
  const buy = side === 'buy', coin = { decimals: market.decimals, unit: `$${market.symbol}` }, solUnit = { decimals: 9, unit: 'SOL' }
  return Object.freeze({
    pay: { raw: BigInt(amount), ...(buy ? solUnit : coin) },
    fee: { lamports: BigInt(estimate.creatorFee ?? 0), bps: Number(market.creatorFeeBps) || 0 },
    burned: { raw: BigInt(estimate.burned ?? 0), ...coin, bps: Number(buy ? market.burnBuyBps : market.burnSellBps) || 0 },
    receive: { raw: BigInt(estimate.delivered), ...(buy ? coin : solUnit) },
    minimum: { raw: estimate.minAmountOut === null || estimate.minAmountOut === undefined ? null : BigInt(estimate.minAmountOut), ...(buy ? coin : solUnit) },
  })
}

// How much more of a capped coin this wallet may hold, before any click. null when no cap applies (graduated, or a
// selected hook that sets its own limits).
export function capRoom(market, held = 0n) {
  if (!market || market.graduated || market.policyKind === 'selected-hook' || !market.capRaw) return null
  const capRaw = BigInt(market.capRaw), h = BigInt(held ?? 0), room = capRaw > h ? capRaw - h : 0n
  return { capRaw, held: h, room, full: room === 0n }
}

// The launch form's live limit: "7% of 10% max", blocked with a reason when over (or when no total is set).
export function launchLimit({ totalBps, maxBps }) {
  const total = Number(totalBps), max = Number(maxBps)
  if (!Number.isFinite(total) || totalBps === '' || totalBps === null) return { ok: false, text: `— of ${pct(max)} max`, fill: 0, reason: 'Set a total fee.' }
  const fill = max > 0 ? Math.min(1, total / max) : 1
  if (total > max) return { ok: false, text: `${pct(total)} of ${pct(max)} max`, fill, reason: `The total fee can be ${pct(max)} at most. Lower it to launch.` }
  return { ok: true, text: `${pct(total)} of ${pct(max)} max`, fill, reason: '' }
}

// Hook types a listed coin carries, for the browse chips and badges.
export const HOOK_TYPES = Object.freeze([['max-wallet', 'Max wallet'], ['burn', 'Burn'], ['creator-fee', 'Creator fee'], ['holders', 'Holders']])
export function coinTags(coin) {
  return [coin.capBps > 0 && 'max-wallet', coin.burnBps > 0 && 'burn', coin.creatorFeeBps > 0 && 'creator-fee', coin.holderBps > 0 && 'holders'].filter(Boolean)
}
export const filterCoins = (coins, tag) => tag === 'all' || !tag ? [...coins] : coins.filter(c => coinTags(c).includes(tag))

// Coins burned so far: the mint's supply drop (initial supply minus current supply), in raw units and basis points.
export function burnedTotal(market) {
  if (!market?.initialSupply || market.supply === null || market.supply === undefined) return null
  const initial = BigInt(market.initialSupply), raw = initial - BigInt(market.supply)
  return { raw: raw > 0n ? raw : 0n, bps: Number(raw > 0n ? raw : 0n) * 10000 / Number(initial) }
}

// Launch presets (owner pass): a starting point the creator can still adjust with the sliders. Holder rewards waits for
// Holders Earn (HOOK_HOLDERS_ENABLED); a burn coin needs Burn on.
export const LAUNCH_PRESETS = Object.freeze([
  { id: 'burn', label: 'Burn coin', hint: '5% fee: 3% burned, 2% creator', totalBps: 500, burnShareBps: 6000 },
  { id: 'holders', label: 'Holder rewards', hint: 'Fees paid to holders', soon: true },
  { id: 'creator', label: 'Creator coin', hint: '2% fee, all to the creator', totalBps: 200, burnShareBps: 0 },
])
// What a preset sets on the form, or null when it can't apply here. burnEnabled: the open launch's Burn switch.
export function presetFields(preset, { burnEnabled = false, maxCreatorFeeBps = null } = {}) {
  if (!preset || preset.soon) return null
  if (burnEnabled) return { totalBps: preset.totalBps, burnShareBps: preset.burnShareBps }
  if (preset.burnShareBps) return null
  const max = Number.isInteger(maxCreatorFeeBps) ? maxCreatorFeeBps : preset.totalBps
  return { creatorFeeBps: Math.min(preset.totalBps, max) }
}
// Which preset the form currently matches (for the pressed state), or null.
export function activePreset({ burnEnabled, totalBps, burnShareBps, creatorFeeBps }) {
  return LAUNCH_PRESETS.find(p => !p.soon && (burnEnabled ? p.totalBps === totalBps && p.burnShareBps === burnShareBps
    : !p.burnShareBps && p.totalBps === creatorFeeBps))?.id ?? null
}

// The wallet as the panel shows it right after a confirmed trade, before the next market read lands (which replaces it).
// buy: SOL out, coins in; sell: coins out, SOL in. Never below zero.
export function optimisticWallet(view, { side, amount, received }) {
  const w = view?.wallet
  if (!w) return view
  const clamp = v => (v < 0n ? 0n : v), a = BigInt(amount), r = BigInt(received ?? 0)
  const coin = BigInt(w.coin ?? 0), lamports = BigInt(w.lamports ?? 0)
  const next = side === 'buy' ? { coin: String(coin + r), lamports: String(clamp(lamports - a)) } : { coin: String(clamp(coin - a)), lamports: String(lamports + r) }
  return { ...view, wallet: { ...w, ...next } }
}

// The status bar's stage for a signing step: approve (review, sign) → sent → confirmed → done, or failed.
export const TRADE_STAGES = Object.freeze(['Approve', 'Sent', 'Confirming', 'Done'])
export function tradeStage(status) {
  if (status === 'failed') return { index: -1, failed: true }
  return { index: { todo: 0, review: 0, sign: 0, send: 1, confirm: 2, done: 3 }[status] ?? 0, failed: false }
}

// Buy size buttons (SOL) and the remembered default. Sizes over this wallet's max buy are left out.
export const BUY_SIZES = Object.freeze(['0.1', '0.5', '1'])
export const BUY_DEFAULT_KEY = 'repoing:hooks:buy-size'
export function rememberedSize(storage) { try { const v = storage?.getItem(BUY_DEFAULT_KEY); return BUY_SIZES.includes(v) ? v : null } catch { return null } }
export function rememberSize(storage, size) { try { if (BUY_SIZES.includes(size)) storage?.setItem(BUY_DEFAULT_KEY, size) } catch {} }
