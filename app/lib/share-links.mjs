// Public share links only: no wallet address, amount or signature goes into a post by default.
export const SITE_ORIGIN = 'https://repo.ing'
export const X_HANDLE = 'repodoting'
const PAYS = "every trade pays the repo's builders in SOL"

export function tokenPageUrl(mint, origin = SITE_ORIGIN) {
  return `${origin}/token/${encodeURIComponent(String(mint ?? ''))}`
}

export function shareText({ fullName, symbol, kind = 'buy' } = {}) {
  const name = String(fullName || (symbol ? `$${symbol}` : '') || 'an open source repo').slice(0, 100)
  const lead = kind === 'launch' ? `I just launched a market for ${name}` : kind === 'sell' ? `I'm trading ${name}` : `I just backed ${name}`
  return `${lead} on @${X_HANDLE} — ${PAYS}`
}

export function xShareUrl({ mint, origin = SITE_ORIGIN, ...details }) {
  const query = new URLSearchParams({ text: shareText(details), url: tokenPageUrl(mint, origin) })
  return `https://x.com/intent/post?${query}`
}

// A shared return is only { mint, pct }: never the wallet, SOL amounts or position size. The
// card labels it as the sharer's own reported figure, so a hand-edited URL claims nothing about anyone.
export const RETURN_MIN = -99.9, RETURN_MAX = 100000
const RETURN_PARAM = /^-?(0|[1-9]\d{0,5})\.\d$/

// Rounds to one decimal inside the bounds; null when there is no figure to share.
export function sharedReturn(percent) {
  if (percent === null || percent === undefined || percent === '') return null
  const value = Number(percent)
  if (!Number.isFinite(value)) return null
  return Math.round(Math.min(RETURN_MAX, Math.max(RETURN_MIN, value)) * 10) / 10 || 0
}

export const returnParam = pct => pct.toFixed(1)

// Strict: only the canonical form returnParam writes, inside the bounds. Anything else is null.
export function parseReturnParam(value) {
  if (typeof value !== 'string' || !RETURN_PARAM.test(value) || value === '-0.0') return null
  const pct = Number(value)
  return pct >= RETURN_MIN && pct <= RETURN_MAX ? pct : null
}

export function formatReturn(pct) {
  return `${pct > 0 ? '+' : ''}${pct.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

export function returnPageUrl(mint, pct, origin = SITE_ORIGIN) {
  return `${tokenPageUrl(mint, origin)}/return/${returnParam(pct)}`
}

export function returnShareText({ symbol, fullName, pct }) {
  const market = [symbol ? `$${String(symbol).slice(0, 20)}` : '', fullName ? `(${String(fullName).slice(0, 100)})` : ''].filter(Boolean).join(' ') || 'an open source repo'
  return `${formatReturn(pct)} on ${market} — every trade pays the repo's builders @${X_HANDLE}`
}

export function xReturnShareUrl({ mint, symbol, fullName, percent, origin = SITE_ORIGIN }) {
  const pct = sharedReturn(percent)
  if (!mint || pct === null) return null
  const query = new URLSearchParams({ text: returnShareText({ symbol, fullName, pct }), url: returnPageUrl(mint, pct, origin) })
  return `https://x.com/intent/post?${query}`
}
