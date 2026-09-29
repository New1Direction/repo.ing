// Baseline security headers. A full script/style CSP is intentionally deferred: wallet adapters
// and the inline theme script need a nonce-based policy tested against every wallet first.
const securityHeaders = [
  // Users sign wallet transactions here, so the site must never be framed (clickjacking).
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // app/(site) and app/(ja) are separate root layouts (for <html lang>), so unmatched URLs need app/global-not-found.jsx.
  experimental: { globalNotFound: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
