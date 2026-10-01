import { marketMetricsUrl, marketTradesUrl } from './market-chart-urls.mjs'

// The token page chart used to request its data only after the page's JavaScript downloaded and hydrated. A small
// inline script now starts those requests as soon as the page has painted (two animation frames, so they never
// compete with first paint), and PriceChart takes the in-flight responses instead of requesting them again.
const STORE = '__repoingEarlyChart'
const KINDS = ['trades', 'metrics']

export function earlyChartScript(mint) {
  const urls = { trades: marketTradesUrl(mint), metrics: marketMetricsUrl(mint) }
  // JSON is safe inside <script> once "<" is escaped; mints are base58 anyway.
  const args = JSON.stringify([mint, urls]).replace(/</g, '\\u003c')
  return `(function(a){var m=a[0],u=a[1],s=window.${STORE}=window.${STORE}||{};function go(){${KINDS.map(kind =>
    `var k=m+":${kind}";if(!s[k])s[k]=fetch(u.${kind}).then(function(r){return r.ok?r.json():null}).catch(function(){return null});`).join('')}}` +
    `requestAnimationFrame(function(){requestAnimationFrame(go)})})(${args})`
}

// One-shot: returns the early response promise (resolving to parsed JSON or null) or null when none was started.
// Marking the slot as taken stops a late-running inline script from requesting it again.
export function takeEarlyChart(mint, kind, scope = globalThis.window) {
  if (!scope || !KINDS.includes(kind)) return null
  const store = scope[STORE] ??= {}
  const key = `${mint}:${kind}`
  const pending = store[key]
  store[key] = 'taken'
  return pending && typeof pending.then === 'function' ? pending : null
}
