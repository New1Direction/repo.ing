import { reportOnlyPolicy } from './app/lib/csp.mjs'

// Baseline security headers. A full script/style CSP is intentionally not enforced yet: wallet adapters
// and the inline theme script need testing against every wallet, so it ships report-only first.
const securityHeaders = [
  // Users sign wallet transactions here, so the site must never be framed (clickjacking).
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Content-Security-Policy-Report-Only', value: reportOnlyPolicy({ dev: process.env.NODE_ENV !== 'production' }) },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Each disposable acceptance site owns its build/lock; leave other dev servers alone.
  ...(process.env.HOOK_LOCAL_ACCEPTANCE === 'true' ? { distDir: `.amp/in/e2e-next-${new URL(process.env.APP_ORIGIN).port}` } : {}),
  // Native read-only SDK uses createRequire/new URL for exact-byte IDLs and manifest.
  serverExternalPackages: ['@repo-ing/hooklab-readonly', '@repo-ing/hooklab-guarded-candidate', '@repo-ing/hooklab-hardened-candidate', '@repo-ing/hooklab-production-candidate'],
  outputFileTracingIncludes: {
    '/*': ['./config/existing-market-custody.json', './.railwayignore', './vendor/hooklab-event-abi/inclusive-max-wallet-candidate/*.json', './vendor/hooklab-production-candidate/idl/bordrless_token.json', './vendor/hooklab-production-candidate/idl/bordrless_bridge.json', './vendor/hooklab-native-candidate/*.json', './vendor/hooklab-native-candidate/open-36dd07e/*.json'],
    '/api/direct-coins': ['./node_modules/@repo-ing/hooklab-guarded-candidate/**/*'],
    '/api/hook-lab': ['./node_modules/@repo-ing/hooklab-guarded-candidate/**/*'],
    '/api/hook-lab/acceptance': ['./node_modules/@repo-ing/hooklab-guarded-candidate/**/*'],
    '/api/hook-lab/hardened': ['./node_modules/@repo-ing/hooklab-hardened-candidate/**/*'],
    '/api/hook-lab/production': ['./node_modules/@repo-ing/hooklab-production-candidate/**/*'],
    '/api/hook-lab/production/receipts': ['./vendor/hooklab-event-abi/**/*'],
    '/coins/production': ['./node_modules/@repo-ing/hooklab-production-candidate/**/*'],
  },
  // app/(site) and app/(ja) are separate root layouts (for <html lang>), so unmatched URLs need app/global-not-found.jsx.
  experimental: { globalNotFound: true },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Icon-pack art is always requested as /art/<name>.webp?v=<ART_VERSION> (app/lib/art.mjs); a new export bumps
      // the version, so a versioned URL never changes content and can be cached for good.
      { source: '/art/:file*', has: [{ type: 'query', key: 'v' }], headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ]
  },
}

export default nextConfig
