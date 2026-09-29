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
