// Report-only for now: collect violations from real wallets before enforcing anything.
// script-src keeps 'unsafe-inline' because nonces would force every static page to render per request;
// external script hosts are still reported. Browser-side RPC never happens (the app proxies through /api),
// so connect-src only needs MetaMask Connect's analytics and mobile relay.
export const CSP_REPORT_PATH = '/api/csp-report'

export function reportOnlyPolicy({ dev = false } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https://avatars.githubusercontent.com', 'https://raw.githubusercontent.com'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'https://mm-sdk-analytics.api.cx.metamask.io', 'wss://mm-sdk-relay.api.cx.metamask.io', ...(dev ? ['ws:'] : [])],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'report-uri': [CSP_REPORT_PATH],
  }
  return Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}
