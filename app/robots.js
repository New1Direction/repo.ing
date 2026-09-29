// Operator pages are gated and noindex already; keep crawlers off them entirely.
export default function robots() {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/operations/'] },
    sitemap: 'https://repo.ing/sitemap.xml',
  }
}
