// Token-2022 ScaledUiAmount (xStocks, docs/STOCK_QUOTES.md): wallets show raw × multiplier, truncated, while trades, fees and
// settlement stay in raw units. Pure helpers shared by the server and the trade panel.
const MULTIPLIER_TEXT = /^(\d{1,6})(?:\.(\d{1,18}))?$/

// A mint's extension (spl-token getScaledUiAmountConfig) as kept here, or null without it.
export function scaledConfig(config) {
  return config ? { multiplier: config.multiplier, newMultiplier: config.newMultiplier, effectiveAt: Number(config.newMultiplierEffectiveTimestamp) } : null
}

// The multiplier in force at `unixSeconds`, as Token-2022 applies it: the new one from its effective time on.
export function currentMultiplier(config, unixSeconds) {
  if (!config) return 1
  return unixSeconds >= config.effectiveAt ? config.newMultiplier : config.multiplier
}

// A multiplier as exact decimal text; anything but a plain positive decimal fails closed.
export function multiplierText(value) {
  const text = String(value)
  if (!Number.isFinite(value) || value <= 0 || !MULTIPLIER_TEXT.test(text)) throw Error('Stock display multiplier is unavailable')
  return text
}

// "1.0028" → { num: 10028n, den: 10000n }. Anything but a plain positive decimal is refused.
export function parseMultiplier(text) {
  const match = MULTIPLIER_TEXT.exec(String(text ?? ''))
  if (!match) throw Error('Invalid display multiplier')
  const fraction = match[2] ?? '', num = BigInt(match[1] + fraction)
  if (num <= 0n) throw Error('Invalid display multiplier')
  return Object.freeze({ num, den: 10n ** BigInt(fraction.length) })
}

// Raw units → shown base units, rounded up: for an amount someone must add, never shown smaller than it is.
export function shownRoundedUp(raw, scale) {
  return scale ? (BigInt(raw) * scale.num + scale.den - 1n) / scale.den : BigInt(raw)
}
