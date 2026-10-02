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
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }

export function html(element, { query = '' } = {}) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(SearchParamsContext.Provider, { value: new URLSearchParams(query) },
      createElement(WatchlistProvider, null, element))))
}

// Async server components: resolve the tree until only synchronously renderable output is left (Suspense boundaries
// keep their resolved children, as the streamed page ends up showing).
export async function resolveServer(node) {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer))
  if (!node || typeof node !== 'object' || !node.type) return node
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') return resolveServer(await node.type(node.props))
  const children = node.props?.children
  if (children === undefined) return node
  return { ...node, props: { ...node.props, children: await resolveServer(children) } }
}
