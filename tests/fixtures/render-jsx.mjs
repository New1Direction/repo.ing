// Server-render the app's .jsx components to static HTML in node --test (jsx-hooks.mjs compiles them). Import a
// component module with appModule('app/components/ui.jsx'); html(element, { query }) renders it inside the providers the
// components expect (watchlist, app router, search params), so a test sees the markup the page would stream.
import { register } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js'

register(new URL('./jsx-hooks.mjs', import.meta.url))
const root = new URL('../../', import.meta.url)

export const appModule = path => import(new URL(path, root).href)
export const h = createElement

const { WatchlistProvider } = await appModule('app/components/watchlist.jsx')
const { WalletProvider } = await appModule('app/components/wallet.jsx')
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }

// wallet: also mount the wallet provider (whole pages; the header's wallet button needs it).
export function html(element, { query = '', wallet = false } = {}) {
  const watched = createElement(WatchlistProvider, null, element)
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(SearchParamsContext.Provider, { value: new URLSearchParams(query) },
      wallet ? createElement(WalletProvider, null, watched) : watched)))
}

// Page-level renders must stay offline: every fetch fails unless a test routes it (routes: [[RegExp, handler]]).
export function offlineFetch(routes = []) {
  const original = globalThis.fetch, requested = []
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input)
    requested.push(url)
    const route = routes.find(([pattern]) => pattern.test(url))
    if (route) return route[1](url, init)
    throw new TypeError(`offline test: ${url}`)
  }
  return { requested, restore: () => { globalThis.fetch = original } }
}

// Async server components: resolve the tree until only synchronously renderable output is left (Suspense boundaries
// keep their resolved children, as the streamed page ends up showing). Elements passed in any prop (a tab's content, an
// aside) are resolved too.
const ELEMENT = Symbol.for('react.transitional.element')
export async function resolveServer(node) {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer))
  if (!node || typeof node !== 'object') return node
  if (node.$$typeof === ELEMENT) {
    if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') return resolveServer(await node.type(node.props))
    const props = {}
    for (const [key, value] of Object.entries(node.props ?? {})) props[key] = await resolveServer(value)
    return { ...node, props }
  }
  if (Object.getPrototypeOf(node) !== Object.prototype) return node
  const resolved = {}
  for (const [key, value] of Object.entries(node)) resolved[key] = await resolveServer(value)
  return resolved
}
