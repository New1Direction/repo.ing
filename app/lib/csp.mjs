// Report-only for now: collect violations from real wallets before enforcing anything.
// script-src keeps 'unsafe-inline' because nonces would force every static page to render per request;
// external script hosts are still reported. Browser-side RPC never happens (the app proxies through /api),
// so connect-src only needs MetaMask Connect's analytics and mobile relay. Cloudflare injects its Web
// Analytics beacon on every proxied page (reported 161x before this was allowed).
export const CSP_REPORT_PATH = '/api/csp-report'

export function reportOnlyPolicy({ dev = false } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", 'https://static.cloudflareinsights.com', ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https://avatars.githubusercontent.com', 'https://raw.githubusercontent.com', 'https://pbs.twimg.com'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'https://cloudflareinsights.com', 'https://mm-sdk-analytics.api.cx.metamask.io', 'wss://mm-sdk-relay.api.cx.metamask.io', ...(dev ? ['ws:'] : [])],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'report-uri': [CSP_REPORT_PATH],
  }
  return Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}
