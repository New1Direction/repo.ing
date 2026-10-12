import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { appModule, h } from './fixtures/render-jsx.mjs'

const { WatchlistContext, WatchButton, useWatchlist } = await appModule('app/components/watchlist.jsx')

// What the provider holds once its effect has read this browser's storage: one watched market, ready, a storage notice.
const browser = {
  state: { version: 1, items: [{ repoId: '42', fullName: 'octo/cat', symbol: 'CAT' }], alertPercent: 10, baselines: {}, notifications: [] },
  ready: true, update() {}, storageError: 'Browser storage is unavailable.', priceError: 'Price check failed.',
}

test('a part of the page that hydrates late renders the server watchlist: empty, not ready, no notices', () => {
  // renderToStaticMarkup takes the same server-snapshot path as hydration, which may run after the provider's effect
  // (a streamed Suspense boundary such as Explore's market list): its first render must equal the server's HTML.
  const seen = []
  function Probe() { const { state, ready, storageError, priceError, update } = useWatchlist(); seen.push({ items: state.items.length, alertPercent: state.alertPercent, ready, storageError, priceError, update: typeof update }); return null }
  const html = renderToStaticMarkup(h(WatchlistContext.Provider, { value: browser }, h(Probe), h(WatchButton, { market: { repoId: 42, fullName: 'octo/cat' } })))
  assert.deepEqual(seen, [{ items: 0, alertPercent: 0, ready: false, storageError: '', priceError: '', update: 'function' }])
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Watch octo\/cat"[^>]*aria-pressed="false"/)
  assert.match(html, /> Watch<\/button>/)
})

test('outside a provider the hook still returns nothing', () => {
  let value = 'unset'
  function Probe() { value = useWatchlist(); return null }
  renderToStaticMarkup(h(Probe))
  assert.equal(value, null)
})
