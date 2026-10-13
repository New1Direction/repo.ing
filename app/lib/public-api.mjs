import { publicCacheHeaders } from './cache-headers.mjs'

// Public, read-only, cookie-free JSON for /api/v1 (docs/MARKET_DATA_API.md): any origin may read it from a browser, and every
// answer says which API version produced it.
export const API_VERSION = '2026-10-13'
export const corsHeaders = Object.freeze({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'X-Repoing-Api-Version': API_VERSION })
export const apiHeaders = (edgeSeconds, staleSeconds = 0) => ({ ...publicCacheHeaders(edgeSeconds, staleSeconds), ...corsHeaders })
export const apiNoStore = Object.freeze({ 'Cache-Control': 'no-store', ...corsHeaders })
export const apiOptions = () => new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } })
// JSON with bigints as decimal strings.
export const apiJson = (body, init) => new Response(JSON.stringify(body, (key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
