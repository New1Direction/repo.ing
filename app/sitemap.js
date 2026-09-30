import { database } from './lib/server.mjs'

const SITE = 'https://repo.ing'
// Public, indexable pages. /builders and /wallet are noindex; operator and claim pages are private.
const PAGES = [
  ['/', 1, 'hourly'], ['/explore', 0.9, 'hourly'], ['/launch', 0.8, 'daily'], ['/find-repos', 0.7, 'daily'],
  ['/stats', 0.7, 'daily'], ['/waiting', 0.7, 'hourly'], ['/parts', 0.7, 'daily'], ['/discoverers', 0.6, 'daily'], ['/how-it-works', 0.6, 'monthly'],
  ['/about', 0.5, 'monthly'], ['/ja', 0.5, 'monthly'],
]

// Rendered per request: token pages come from the database, which is unavailable at build time.
export const dynamic = 'force-dynamic'

async function tokenPages() {
  const pool = database()
  if (!pool) return []
  try {
    const { rows } = await pool.query(`select mint, indexed_at as "indexedAt" from markets
      where status = 'confirmed' and indexed_at is not null and launch_finality = 'finalized'
      order by indexed_at desc limit 5000`)
    return rows.map(row => ({ url: `${SITE}/token/${row.mint}`, lastModified: row.indexedAt, changeFrequency: 'hourly', priority: 0.8 }))
  } catch (error) {
    console.error('sitemap token query failed', { error: error.message })
    return []
  }
}

export default async function sitemap() {
  const pages = PAGES.map(([path, priority, changeFrequency]) => ({ url: `${SITE}${path === '/' ? '' : path}`, changeFrequency, priority }))
  return [...pages, ...await tokenPages()]
}
