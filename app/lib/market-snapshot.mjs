// The token page's chart and metrics reads, shared with the phone market summary: one fetch, two views. PriceChart
// publishes what it already loaded; subscribers get the merged snapshot for their mint. Browser only.
const STORE = '__repoingMarketSnapshot'
const EVENT = 'repoing:market-snapshot'

export function publishMarketSnapshot(mint, patch, scope = globalThis.window) {
  if (!scope || !mint || !patch) return
  const store = scope[STORE] ??= {}
  store[mint] = { ...store[mint], ...patch }
  scope.dispatchEvent(new CustomEvent(EVENT, { detail: { mint } }))
}

export const readMarketSnapshot = (mint, scope = globalThis.window) => scope?.[STORE]?.[mint] ?? null

export function subscribeMarketSnapshot(mint, onChange, scope = globalThis.window) {
  if (!scope) return () => {}
  const listener = event => { if (event.detail?.mint === mint) onChange(readMarketSnapshot(mint, scope)) }
  scope.addEventListener(EVENT, listener)
  return () => scope.removeEventListener(EVENT, listener)
}
